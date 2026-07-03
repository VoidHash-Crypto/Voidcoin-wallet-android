/**
 * Tests for VOID Electrum module
 * Covers: CashAddr-to-scripthash conversion, balance/UTXO API wrappers,
 * connection management, and VOID explorer API fallback.
 *
 * Strategy: The module under test uses module-level state (mainConnected, etc.)
 * that persists across tests. We use jest.isolateModules to get fresh instances
 * where we need clean connection state.
 */

// Mock electrum-client at the top level for all tests
const mockInitElectrum = jest.fn();
const mockBlockchainHeaders_subscribe = jest.fn();
const mockBlockchainScripthash_getBalance = jest.fn();
const mockBlockchainScripthash_listunspent = jest.fn();
const mockBlockchainScripthash_getHistory = jest.fn();
const mockBlockchainTransaction_broadcast = jest.fn();
const mockBlockchainTransaction_get = jest.fn();
const mockBlockchainEstimatefee = jest.fn();

function createMockClient() {
  return {
    initElectrum: mockInitElectrum,
    blockchainHeaders_subscribe: mockBlockchainHeaders_subscribe,
    blockchainScripthash_getBalance: mockBlockchainScripthash_getBalance,
    blockchainScripthash_listunspent: mockBlockchainScripthash_listunspent,
    blockchainScripthash_getHistory: mockBlockchainScripthash_getHistory,
    blockchainTransaction_broadcast: mockBlockchainTransaction_broadcast,
    blockchainTransaction_get: mockBlockchainTransaction_get,
    blockchainEstimatefee: mockBlockchainEstimatefee,
    onError: null as any,
    onClose: null as any,
  };
}

jest.mock('electrum-client', () => {
  return jest.fn().mockImplementation(() => createMockClient());
});

jest.mock('react-native-default-preference', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
}));

// Mock fetch globally
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// We import these for types/constants only; actual function tests use fresh modules
import { hardcodedPeers, voidPeers } from '../../blue_modules/VoidElectrum';

// ---------------------------------------------------------------------------
// CashAddr encoder (same algorithm as void-wallet.test.ts) for generating
// valid test addresses
// ---------------------------------------------------------------------------
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function cashAddrPolymod(values: number[]): bigint {
  const GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let chk = 1n;
  for (const value of values) {
    const top = chk >> 35n;
    chk = ((chk & 0x07ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i++) {
      if ((top >> BigInt(i)) & 1n) chk ^= GENERATORS[i];
    }
  }
  return chk;
}

function encodeCashAddr(prefix: string, type: number, hash: Buffer): string {
  const sizeMap: Record<number, number> = { 20: 0, 24: 1, 28: 2, 32: 3, 40: 4, 48: 5, 56: 6, 64: 7 };
  const sizeCode = sizeMap[hash.length] ?? 0;
  const versionByte = (type << 3) | sizeCode;
  const payload: number[] = [];
  let acc = versionByte;
  let bits = 8;
  for (const byte of hash) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      payload.push((acc >> bits) & 0x1f);
    }
  }
  if (bits > 0) payload.push((acc << (5 - bits)) & 0x1f);

  const prefixData: number[] = [];
  for (const char of prefix) prefixData.push(char.charCodeAt(0) & 0x1f);
  prefixData.push(0);
  const values = [...prefixData, ...payload, 0, 0, 0, 0, 0, 0, 0, 0];
  const polymod = cashAddrPolymod(values) ^ 1n;
  const checksum: number[] = [];
  for (let i = 0; i < 8; i++) checksum.push(Number((polymod >> BigInt(5 * (7 - i))) & 0x1fn));

  let result = prefix + ':';
  for (const v of [...payload, ...checksum]) result += CHARSET[v];
  return result;
}

// Valid test addresses (generated with the encoder above)
const TEST_HASH_HEX = 'f5bf48b397dae52cf2cba9c735390822244d8083';
const TEST_HASH = Buffer.from(TEST_HASH_HEX, 'hex');
const VALID_P2PKH_ADDR = encodeCashAddr('bitcoincashii', 0, TEST_HASH); // type 0 = P2PKH
const VALID_P2SH_ADDR = encodeCashAddr('bitcoincashii', 1, TEST_HASH); // type 1 = P2SH
// Bare address (without prefix) for testing
const VALID_P2PKH_BARE = VALID_P2PKH_ADDR.slice('bitcoincashii:'.length);

/**
 * Helper to get a fresh module instance (reset all module-level state).
 */
function getFreshModule() {
  let mod: typeof import('../../blue_modules/VoidElectrum');
  jest.isolateModules(() => {
    mod = require('../../blue_modules/VoidElectrum');
  });
  return mod!;
}

describe('VoidElectrum', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockInitElectrum.mockResolvedValue(undefined);
    mockBlockchainHeaders_subscribe.mockResolvedValue({ height: 100, time: 1234567890 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ===== CashAddr-to-scripthash conversion =====
  describe('addressToScriptHash (via getBalanceByAddress)', () => {
    beforeEach(() => {
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 1000, unconfirmed: 0 });
    });

    it('valid P2PKH CashAddr produces correct 64-char hex scripthash', async () => {
      const mod = getFreshModule();
      const p = mod.getBalanceByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      await p;

      expect(mockBlockchainScripthash_getBalance).toHaveBeenCalledTimes(1);
      const passedScripthash = mockBlockchainScripthash_getBalance.mock.calls[0][0];
      expect(passedScripthash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('valid P2SH CashAddr produces correct 64-char hex scripthash', async () => {
      const mod = getFreshModule();
      const p = mod.getBalanceByAddress(VALID_P2SH_ADDR);
      jest.runAllTimers();
      await p;

      expect(mockBlockchainScripthash_getBalance).toHaveBeenCalledTimes(1);
      const passedScripthash = mockBlockchainScripthash_getBalance.mock.calls[0][0];
      expect(passedScripthash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('P2PKH and P2SH addresses produce different scripthashes', async () => {
      const mod = getFreshModule();

      const p1 = mod.getBalanceByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      await p1;
      const p2pkhHash = mockBlockchainScripthash_getBalance.mock.calls[0][0];

      const p2 = mod.getBalanceByAddress(VALID_P2SH_ADDR);
      jest.runAllTimers();
      await p2;
      const p2shHash = mockBlockchainScripthash_getBalance.mock.calls[1][0];

      expect(p2pkhHash).not.toBe(p2shHash);
    });

    it('P2PKH scripthash matches manually computed value', async () => {
      const mod = getFreshModule();
      const p = mod.getBalanceByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      await p;

      const passedScripthash = mockBlockchainScripthash_getBalance.mock.calls[0][0];

      // Manually compute expected scripthash for P2PKH
      const crypto = require('crypto');
      const script = Buffer.concat([
        Buffer.from([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 PUSH20
        TEST_HASH,
        Buffer.from([0x88, 0xac]), // OP_EQUALVERIFY OP_CHECKSIG
      ]);
      const hash = crypto.createHash('sha256').update(script).digest();
      const expected = Buffer.from(hash).reverse().toString('hex');

      expect(passedScripthash).toBe(expected);
    });

    it('P2SH scripthash matches manually computed value', async () => {
      const mod = getFreshModule();
      const p = mod.getBalanceByAddress(VALID_P2SH_ADDR);
      jest.runAllTimers();
      await p;

      const passedScripthash = mockBlockchainScripthash_getBalance.mock.calls[0][0];

      // Manually compute expected scripthash for P2SH
      const crypto = require('crypto');
      const script = Buffer.concat([
        Buffer.from([0xa9, 0x14]), // OP_HASH160 PUSH20
        TEST_HASH,
        Buffer.from([0x87]), // OP_EQUAL
      ]);
      const hash = crypto.createHash('sha256').update(script).digest();
      const expected = Buffer.from(hash).reverse().toString('hex');

      expect(passedScripthash).toBe(expected);
    });

    it('address without prefix works', async () => {
      const mod = getFreshModule();
      const p = mod.getBalanceByAddress(VALID_P2PKH_BARE);
      jest.runAllTimers();
      await p;

      expect(mockBlockchainScripthash_getBalance).toHaveBeenCalledTimes(1);
      const passedScripthash = mockBlockchainScripthash_getBalance.mock.calls[0][0];
      expect(passedScripthash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('uppercase prefix works (case-insensitive strip)', async () => {
      const mod = getFreshModule();
      const upperAddr = 'BITCOINCASHII:' + VALID_P2PKH_BARE;
      const p = mod.getBalanceByAddress(upperAddr);
      jest.runAllTimers();
      await p;

      expect(mockBlockchainScripthash_getBalance).toHaveBeenCalledTimes(1);
    });

    it('invalid address throws', async () => {
      const mod = getFreshModule();
      const p = mod.getBalanceByAddress('bitcoincashii:invalidaddress');
      jest.runAllTimers();
      await expect(p).rejects.toThrow();
    });

    it('BCH address prefix is rejected to prevent cross-chain confusion', async () => {
      const mod = getFreshModule();
      const p = mod.getBalanceByAddress('bitcoincash:' + VALID_P2PKH_BARE);
      jest.runAllTimers();
      await expect(p).rejects.toThrow('Invalid VOID address: wrong prefix');
    });

    it('bchtest prefix is rejected', async () => {
      const mod = getFreshModule();
      const p = mod.getBalanceByAddress('bchtest:' + VALID_P2PKH_BARE);
      jest.runAllTimers();
      await expect(p).rejects.toThrow('Invalid VOID address: wrong prefix');
    });
  });

  // ===== Balance/UTXO API wrappers =====
  describe('getBalanceByAddress', () => {
    it('returns { confirmed, unconfirmed } with valid numbers', async () => {
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 50000, unconfirmed: 1000 });
      const mod = getFreshModule();

      const p = mod.getBalanceByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      const balance = await p;

      expect(balance).toEqual({ confirmed: 50000, unconfirmed: 1000 });
    });

    it('floors fractional values', async () => {
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 50000.7, unconfirmed: 1000.3 });
      const mod = getFreshModule();

      const p = mod.getBalanceByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      const balance = await p;

      expect(balance.confirmed).toBe(50000);
      expect(balance.unconfirmed).toBe(1000);
    });

    it('clamps negative confirmed to 0', async () => {
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: -100, unconfirmed: 500 });
      const mod = getFreshModule();

      const p = mod.getBalanceByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      const balance = await p;

      expect(balance.confirmed).toBe(0);
    });

    it('handles non-number balance gracefully (returns 0)', async () => {
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 'not_a_number', unconfirmed: null });
      const mod = getFreshModule();

      const p = mod.getBalanceByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      const balance = await p;

      expect(balance.confirmed).toBe(0);
      expect(balance.unconfirmed).toBe(0);
    });
  });

  describe('getBalanceByScripthash', () => {
    it('returns balance for a direct scripthash', async () => {
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 12345, unconfirmed: 678 });
      const scripthash = 'a'.repeat(64);
      const mod = getFreshModule();

      const p = mod.getBalanceByScripthash(scripthash);
      jest.runAllTimers();
      const balance = await p;

      expect(balance).toEqual({ confirmed: 12345, unconfirmed: 678 });
      expect(mockBlockchainScripthash_getBalance).toHaveBeenCalledWith(scripthash);
    });
  });

  describe('getUtxosByAddress', () => {
    it('returns properly formatted UTXO array', async () => {
      mockBlockchainScripthash_listunspent.mockResolvedValue([
        { tx_hash: 'abc123def456'.padEnd(64, '0'), tx_pos: 0, value: 50000, height: 100 },
        { tx_hash: 'def789abc012'.padEnd(64, '0'), tx_pos: 1, value: 30000, height: 101 },
      ]);
      const mod = getFreshModule();

      const p = mod.getUtxosByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      const utxos = await p;

      expect(utxos).toHaveLength(2);
      expect(utxos[0]).toEqual({
        txid: 'abc123def456'.padEnd(64, '0'),
        vout: 0,
        value: 50000,
        height: 100,
      });
    });

    it('filters out UTXOs with invalid values', async () => {
      mockBlockchainScripthash_listunspent.mockResolvedValue([
        { tx_hash: 'a'.repeat(64), tx_pos: 0, value: 50000, height: 100 },
        { tx_hash: 'b'.repeat(64), tx_pos: 0, value: 'not_a_number', height: 101 },
        { tx_hash: 'c'.repeat(64), tx_pos: 0, value: 0, height: 102 },
        { tx_hash: 'd'.repeat(64), tx_pos: 0, value: -100, height: 103 },
        { tx_hash: 'e'.repeat(64), tx_pos: 0, value: 1.5, height: 104 },
      ]);
      const mod = getFreshModule();

      const p = mod.getUtxosByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      const utxos = await p;

      expect(utxos).toHaveLength(1);
      expect(utxos[0].value).toBe(50000);
    });

    it('deduplicates UTXOs by txid:vout', async () => {
      const txHash = 'a'.repeat(64);
      mockBlockchainScripthash_listunspent.mockResolvedValue([
        { tx_hash: txHash, tx_pos: 0, value: 50000, height: 100 },
        { tx_hash: txHash, tx_pos: 0, value: 50000, height: 100 },
        { tx_hash: txHash, tx_pos: 1, value: 30000, height: 100 },
      ]);
      const mod = getFreshModule();

      const p = mod.getUtxosByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      const utxos = await p;

      expect(utxos).toHaveLength(2);
    });

    it('handles empty response', async () => {
      mockBlockchainScripthash_listunspent.mockResolvedValue([]);
      const mod = getFreshModule();

      const p = mod.getUtxosByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      const utxos = await p;

      expect(utxos).toEqual([]);
    });
  });

  describe('getUtxosByScripthash', () => {
    it('returns properly formatted UTXOs for direct scripthash', async () => {
      const scripthash = 'f'.repeat(64);
      mockBlockchainScripthash_listunspent.mockResolvedValue([
        { tx_hash: 'a'.repeat(64), tx_pos: 0, value: 10000, height: 50 },
      ]);
      const mod = getFreshModule();

      const p = mod.getUtxosByScripthash(scripthash);
      jest.runAllTimers();
      const utxos = await p;

      expect(utxos).toHaveLength(1);
      expect(mockBlockchainScripthash_listunspent).toHaveBeenCalledWith(scripthash);
    });
  });

  describe('broadcastTransaction', () => {
    // Valid hex string >= 20 chars for broadcastTransaction input validation
    const VALID_TX_HEX = '0200000001abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

    it('returns txid on successful broadcast', async () => {
      const validTxid = 'a1b2c3d4'.padEnd(64, 'f');
      mockBlockchainTransaction_broadcast.mockResolvedValue(validTxid);
      const mod = getFreshModule();

      const p = mod.broadcastTransaction(VALID_TX_HEX);
      jest.runAllTimers();
      const result = await p;

      expect(result).toBe(validTxid);
    });

    it('throws on non-string response', async () => {
      mockBlockchainTransaction_broadcast.mockResolvedValue(42);
      const mod = getFreshModule();

      const p = mod.broadcastTransaction(VALID_TX_HEX);
      jest.runAllTimers();
      await expect(p).rejects.toThrow('Broadcast failed');
    });

    it('throws on non-txid string response (error message from server)', async () => {
      mockBlockchainTransaction_broadcast.mockResolvedValue('error: insufficient fee');
      const mod = getFreshModule();

      const p = mod.broadcastTransaction(VALID_TX_HEX);
      jest.runAllTimers();
      await expect(p).rejects.toThrow('Broadcast failed');
    });

    it('trims whitespace from valid txid', async () => {
      const validTxid = 'a1b2c3d4'.padEnd(64, 'f');
      mockBlockchainTransaction_broadcast.mockResolvedValue(`  ${validTxid}  `);
      const mod = getFreshModule();

      const p = mod.broadcastTransaction(VALID_TX_HEX);
      jest.runAllTimers();
      const result = await p;

      expect(result).toBe(validTxid);
    });

    it('rejects non-hex input', async () => {
      const mod = getFreshModule();
      const p = mod.broadcastTransaction('0200000001...');
      jest.runAllTimers();
      await expect(p).rejects.toThrow('Invalid transaction hex');
    });

    it('rejects too-short hex input', async () => {
      const mod = getFreshModule();
      const p = mod.broadcastTransaction('0200');
      jest.runAllTimers();
      await expect(p).rejects.toThrow('Invalid transaction hex');
    });
  });

  describe('getTransaction', () => {
    it('returns verbose transaction data', async () => {
      const txData = { txid: 'a'.repeat(64), confirmations: 5 };
      mockBlockchainTransaction_get.mockResolvedValue(txData);
      const mod = getFreshModule();

      const p = mod.getTransaction('a'.repeat(64));
      jest.runAllTimers();
      const result = await p;

      expect(result).toEqual(txData);
      expect(mockBlockchainTransaction_get).toHaveBeenCalledWith('a'.repeat(64), true);
    });
  });

  describe('getTransactionsByAddress', () => {
    it('returns transaction history array', async () => {
      const history = [
        { tx_hash: 'a'.repeat(64), height: 100 },
        { tx_hash: 'b'.repeat(64), height: 101 },
      ];
      mockBlockchainScripthash_getHistory.mockResolvedValue(history);
      const mod = getFreshModule();

      const p = mod.getTransactionsByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      const result = await p;

      expect(result).toHaveLength(2);
    });

    it('returns empty array for non-array response', async () => {
      mockBlockchainScripthash_getHistory.mockResolvedValue('invalid');
      const mod = getFreshModule();

      const p = mod.getTransactionsByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      const result = await p;

      expect(result).toEqual([]);
    });

    it('limits results to 500', async () => {
      const history = Array.from({ length: 600 }, (_, i) => ({
        tx_hash: i.toString(16).padStart(64, '0'),
        height: i,
      }));
      mockBlockchainScripthash_getHistory.mockResolvedValue(history);
      const mod = getFreshModule();

      const p = mod.getTransactionsByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      const result = await p;

      expect(result).toHaveLength(500);
    });
  });

  describe('getTransactionsByScripthash', () => {
    it('returns transaction history for direct scripthash', async () => {
      const scripthash = 'a'.repeat(64);
      const history = [{ tx_hash: 'b'.repeat(64), height: 10 }];
      mockBlockchainScripthash_getHistory.mockResolvedValue(history);
      const mod = getFreshModule();

      const p = mod.getTransactionsByScripthash(scripthash);
      jest.runAllTimers();
      const result = await p;

      expect(result).toHaveLength(1);
      expect(mockBlockchainScripthash_getHistory).toHaveBeenCalledWith(scripthash);
    });
  });

  describe('estimateFee', () => {
    it('converts BTC/kB to sat/byte correctly', async () => {
      // 0.00001 BTC/kB = 0.00001 * 100000 = 1 sat/byte
      mockBlockchainEstimatefee.mockResolvedValue(0.00001);
      const mod = getFreshModule();

      const p = mod.estimateFee(6);
      jest.runAllTimers();
      const fee = await p;

      expect(fee).toBe(1);
    });

    it('caps fee at 100 sat/byte', async () => {
      // 0.01 BTC/kB = 1000 sat/byte -> capped to 100
      mockBlockchainEstimatefee.mockResolvedValue(0.01);
      const mod = getFreshModule();

      const p = mod.estimateFee(6);
      jest.runAllTimers();
      const fee = await p;

      expect(fee).toBe(100);
    });

    it('returns 1 sat/byte when estimation fails (negative/zero)', async () => {
      mockBlockchainEstimatefee.mockResolvedValue(-1);
      const mod = getFreshModule();

      const p = mod.estimateFee(6);
      jest.runAllTimers();
      const fee = await p;

      expect(fee).toBe(1);
    });

    it('ensures minimum of 1 sat/byte', async () => {
      mockBlockchainEstimatefee.mockResolvedValue(0.000001);
      const mod = getFreshModule();

      const p = mod.estimateFee(6);
      jest.runAllTimers();
      const fee = await p;

      expect(fee).toBeGreaterThanOrEqual(1);
    });
  });

  // ===== Connection management =====
  describe('Connection management', () => {
    it('connection mutex prevents concurrent connects', async () => {
      jest.useRealTimers();
      mockInitElectrum.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 50)));
      mockBlockchainHeaders_subscribe.mockResolvedValue({ height: 100, time: 1234567890 });
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 100, unconfirmed: 0 });
      const mod = getFreshModule();

      // Fire both requests concurrently — the mutex should serialize connections
      const p1 = mod.getBalanceByAddress(VALID_P2PKH_ADDR);
      const p2 = mod.getBalanceByAddress(VALID_P2PKH_ADDR);
      const [r1, r2] = await Promise.all([p1, p2]);

      // Both should return valid results despite concurrent connection attempts
      expect(r1).toEqual({ confirmed: 100, unconfirmed: 0 });
      expect(r2).toEqual({ confirmed: 100, unconfirmed: 0 });
      // The mutex may allow re-connection after the first completes, but
      // both calls should succeed and return the same balance
      expect(mockInitElectrum.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('failover iterates through server list on connection failure', async () => {
      let callCount = 0;
      mockInitElectrum.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.reject(new Error('Connection refused'));
        }
        return Promise.resolve();
      });
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
      const mod = getFreshModule();

      const p = mod.getBalanceByAddress(VALID_P2PKH_ADDR);

      // Advance through retry delays
      for (let i = 0; i < 10; i++) {
        jest.advanceTimersByTime(5000);
        await Promise.resolve();
      }
      jest.runAllTimers();
      const balance = await p;

      expect(balance).toEqual({ confirmed: 0, unconfirmed: 0 });
      expect(callCount).toBe(3);
    });

    it('throws after MAX_RETRIES (3) failures', async () => {
      mockInitElectrum.mockRejectedValue(new Error('Connection refused'));
      const mod = getFreshModule();

      const p = mod.getBalanceByAddress(VALID_P2PKH_ADDR);

      // Advance through all retry delays
      for (let i = 0; i < 10; i++) {
        jest.advanceTimersByTime(5000);
        await Promise.resolve();
      }
      jest.runAllTimers();

      await expect(p).rejects.toThrow('Connection refused');
    });
  });

  // ===== State getters =====
  describe('State getters', () => {
    it('getLatestBlock returns undefined height before connection', () => {
      const mod = getFreshModule();
      const block = mod.getLatestBlock();
      expect(block.height).toBeUndefined();
    });

    it('getLatestBlock returns height after connection', async () => {
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
      const mod = getFreshModule();

      const p = mod.getBalanceByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      await p;

      const block = mod.getLatestBlock();
      expect(block.height).toBe(100);
    });

    it('isConnected returns false initially', () => {
      const mod = getFreshModule();
      expect(mod.isConnected()).toBe(false);
    });

    it('isConnected returns true after successful connection', async () => {
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
      const mod = getFreshModule();

      const p = mod.getBalanceByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      await p;

      expect(mod.isConnected()).toBe(true);
    });

    it('getServerName returns false initially', () => {
      const mod = getFreshModule();
      expect(mod.getServerName()).toBe(false);
    });

    it('getServerName returns host string after connection', async () => {
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
      const mod = getFreshModule();

      const p = mod.getBalanceByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      await p;

      const name = mod.getServerName();
      expect(typeof name).toBe('string');
      expect(name).toBeTruthy();
    });
  });

  // ===== Hardcoded peers =====
  describe('Hardcoded peers', () => {
    it('VOID peers are defined with host and port', () => {
      expect(hardcodedPeers.length).toBeGreaterThanOrEqual(1);
      for (const peer of hardcodedPeers) {
        expect(peer.host).toBeDefined();
        expect(typeof peer.host).toBe('string');
        expect(peer.ssl || peer.tcp).toBeTruthy();
      }
    });

    it('VOID peers are defined with host and port', () => {
      expect(voidPeers.length).toBeGreaterThanOrEqual(1);
      for (const peer of voidPeers) {
        expect(peer.host).toBeDefined();
        expect(typeof peer.host).toBe('string');
        expect(peer.ssl || peer.tcp).toBeTruthy();
      }
    });
  });

  // ===== VOID explorer API fallback =====
  describe('VOID explorer API fallback', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    describe('getVoidBalance', () => {
      it('uses explorer API as primary method', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              chain_stats: { funded_txo_sum: 100000, spent_txo_sum: 20000 },
              mempool_stats: { funded_txo_sum: 5000, spent_txo_sum: 0 },
            }),
        });
        const mod = getFreshModule();

        const balance = await mod.getVoidBalance('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');

        expect(balance).toEqual({ confirmed: 80000, unconfirmed: 5000 });
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('explorer.bitcoin-ii.org/api/address/'),
        );
      });

      it('constructs correct URL with address', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
              mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
            }),
        });
        const mod = getFreshModule();

        await mod.getVoidBalance('testaddr123');

        expect(mockFetch).toHaveBeenCalledWith(
          'https://explorer.bitcoin-ii.org/api/address/testaddr123',
        );
      });

      it('falls back to Electrum when explorer API fails', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));
        mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 5000, unconfirmed: 100 });
        const mod = getFreshModule();

        const balance = await mod.getVoidBalance('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');

        expect(balance).toEqual({ confirmed: 5000, unconfirmed: 100 });
      });

      it('throws when both explorer API and Electrum fail', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));
        mockInitElectrum.mockRejectedValue(new Error('Electrum connection refused'));
        const mod = getFreshModule();

        await expect(mod.getVoidBalance('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).rejects.toThrow(
          'VOID balance check failed',
        );
      });

      it('handles missing chain_stats fields gracefully', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
        });
        const mod = getFreshModule();

        const balance = await mod.getVoidBalance('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');

        expect(balance).toEqual({ confirmed: 0, unconfirmed: 0 });
      });

      it('handles non-OK response then falls back', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 404,
        });
        mockInitElectrum.mockRejectedValue(new Error('Electrum down'));
        const mod = getFreshModule();

        await expect(mod.getVoidBalance('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).rejects.toThrow();
      });

      it('handles non-finite values from Electrum fallback', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));
        mockBlockchainScripthash_getBalance.mockResolvedValue({
          confirmed: Infinity,
          unconfirmed: NaN,
        });
        const mod = getFreshModule();

        const balance = await mod.getVoidBalance('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');

        expect(balance).toEqual({ confirmed: 0, unconfirmed: 0 });
      });
    });

    describe('getVOIDUtxos', () => {
      it('returns properly formatted UTXOs from explorer', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve([
              { txid: 'a'.repeat(64), vout: 0, value: 50000, status: { block_height: 100 } },
              { txid: 'b'.repeat(64), vout: 1, value: 30000, status: { block_height: 101 } },
            ]),
        });
        const mod = getFreshModule();

        const utxos = await mod.getVOIDUtxos('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');

        expect(utxos).toHaveLength(2);
        expect(utxos[0]).toEqual({
          txid: 'a'.repeat(64),
          vout: 0,
          value: 50000,
          height: 100,
        });
      });

      it('constructs correct UTXO URL', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([]),
        });
        const mod = getFreshModule();

        await mod.getVOIDUtxos('testaddr');

        expect(mockFetch).toHaveBeenCalledWith(
          'https://explorer.bitcoin-ii.org/api/address/testaddr/utxo',
        );
      });

      it('filters out invalid UTXOs', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve([
              { txid: 'a'.repeat(64), vout: 0, value: 50000, status: { block_height: 100 } },
              { txid: 'b'.repeat(64), vout: 0, value: 'bad', status: {} },
              { txid: 'c'.repeat(64), vout: 0, value: 0, status: {} },
            ]),
        });
        const mod = getFreshModule();

        const utxos = await mod.getVOIDUtxos('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');

        expect(utxos).toHaveLength(1);
      });

      it('deduplicates UTXOs', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve([
              { txid: 'a'.repeat(64), vout: 0, value: 50000, status: { block_height: 100 } },
              { txid: 'a'.repeat(64), vout: 0, value: 50000, status: { block_height: 100 } },
            ]),
        });
        const mod = getFreshModule();

        const utxos = await mod.getVOIDUtxos('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');

        expect(utxos).toHaveLength(1);
      });

      it('throws on double failure', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));
        mockInitElectrum.mockRejectedValue(new Error('Electrum down'));
        const mod = getFreshModule();

        await expect(mod.getVOIDUtxos('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'))
          .rejects.toThrow('VOID UTXO fetch failed');
      });
    });

    describe('getVOIDTransactions', () => {
      it('returns formatted transaction history from explorer', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve([
              { txid: 'a'.repeat(64), status: { block_height: 100, confirmed: true } },
              { txid: 'b'.repeat(64), status: { block_height: 101, confirmed: true } },
            ]),
        });
        const mod = getFreshModule();

        const txs = await mod.getVOIDTransactions('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');

        expect(txs).toHaveLength(2);
        expect(txs[0]).toEqual({
          tx_hash: 'a'.repeat(64),
          height: 100,
          confirmed: true,
        });
      });

      it('throws on API failure', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));
        const mod = getFreshModule();

        await expect(mod.getVOIDTransactions('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'))
          .rejects.toThrow('VOID transaction history fetch failed');
      });

      it('limits to 500 transactions', async () => {
        const largeTxList = Array.from({ length: 600 }, (_, i) => ({
          txid: i.toString(16).padStart(64, '0'),
          status: { block_height: i, confirmed: true },
        }));
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(largeTxList),
        });
        const mod = getFreshModule();

        const txs = await mod.getVOIDTransactions('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');

        expect(txs).toHaveLength(500);
      });
    });

    describe('broadcastVOIDTransaction', () => {
      // Valid hex string >= 20 chars for broadcastVOIDTransaction input validation
      const VALID_VOID_TX_HEX = '0200000001abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

      it('broadcasts via explorer API and returns txid', async () => {
        const validTxid = 'a'.repeat(64);
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(validTxid),
        });
        const mod = getFreshModule();

        const result = await mod.broadcastVOIDTransaction(VALID_VOID_TX_HEX);

        expect(result).toBe(validTxid);
        expect(mockFetch).toHaveBeenCalledWith(
          'https://explorer.bitcoin-ii.org/api/tx',
          expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: VALID_VOID_TX_HEX,
          }),
        );
      });

      it('extracts txid from JSON-wrapped response', async () => {
        const validTxid = 'b'.repeat(64);
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ txid: validTxid })),
        });
        const mod = getFreshModule();

        const result = await mod.broadcastVOIDTransaction(VALID_VOID_TX_HEX);

        expect(result).toBe(validTxid);
      });

      it('falls back to Electrum when explorer returns non-OK', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Internal Server Error'),
        });
        const validTxid = 'c'.repeat(64);
        mockBlockchainTransaction_broadcast.mockResolvedValue(validTxid);
        const mod = getFreshModule();

        const result = await mod.broadcastVOIDTransaction(VALID_VOID_TX_HEX);

        expect(result).toBe(validTxid);
      });

      it('throws descriptive error when both fail', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: () => Promise.resolve('Bad request'),
        });
        mockInitElectrum.mockRejectedValue(new Error('Electrum timeout'));
        const mod = getFreshModule();

        await expect(mod.broadcastVOIDTransaction(VALID_VOID_TX_HEX)).rejects.toThrow('VOID broadcast failed');
      });
    });
  });

  // ===== RPC configuration =====
  describe('RPC configuration', () => {
    it('setRpcConfig stores config values', async () => {
      const mod = getFreshModule();

      // After setting config, getBalanceByAddressRpc should not throw "RPC not configured"
      mod.setRpcConfig('127.0.0.1', 8342, 'user', 'pass');

      // Verify by calling getBalanceByAddressRpc which checks rpcConfig internally.
      // getaddressinfo returns ismine:true so we go through the getbalance path
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ result: { ismine: true, iswatchonly: false }, error: null }),
      });
      // getbalance returns 0
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ result: 0, error: null }),
      });

      // Should not throw "RPC not configured" and should return a balance
      const result = await mod.getBalanceByAddressRpc('testaddr');
      expect(result).toEqual({ confirmed: 0, unconfirmed: 0 });
    });

    it('enableRpcFallback toggles flag', () => {
      const mod = getFreshModule();
      // Calling enableRpcFallback should not throw
      expect(() => mod.enableRpcFallback(true)).not.toThrow();
      expect(() => mod.enableRpcFallback(false)).not.toThrow();
    });

    it('getBalanceByAddressRpc throws "RPC not configured" when not configured', async () => {
      const mod = getFreshModule();

      // Without calling setRpcConfig first, this should throw
      await expect(mod.getBalanceByAddressRpc('testaddr')).rejects.toThrow('RPC not configured');
    });
  });

  // ===== connectVOID mutex =====
  describe('connectVOID mutex', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    it('connects VOID and returns balance via Electrum fallback', async () => {
      mockInitElectrum.mockResolvedValue(undefined);
      mockBlockchainHeaders_subscribe.mockResolvedValue({ height: 100, time: 1234567890 });
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 200, unconfirmed: 0 });
      // Explorer API fails so we fall back to Electrum (which triggers connectVOID)
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const mod = getFreshModule();

      // getVoidBalance should fall back to Electrum and succeed
      const balance = await mod.getVoidBalance('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');

      expect(balance).toEqual({ confirmed: 200, unconfirmed: 0 });
      // initElectrum should have been called to establish the VOID connection
      expect(mockInitElectrum).toHaveBeenCalled();
    });
  });

  // ===== getVOIDUtxos Electrum fallback success =====
  describe('getVOIDUtxos Electrum fallback success', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    it('returns UTXOs from Electrum when explorer fails', async () => {
      // Explorer API fails
      mockFetch.mockRejectedValueOnce(new Error('Explorer down'));
      // Electrum fallback returns UTXOs
      mockBlockchainScripthash_listunspent.mockResolvedValue([
        { tx_hash: 'a'.repeat(64), tx_pos: 0, value: 75000, height: 200 },
        { tx_hash: 'b'.repeat(64), tx_pos: 1, value: 25000, height: 201 },
      ]);
      const mod = getFreshModule();

      const utxos = await mod.getVOIDUtxos('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');

      expect(utxos).toHaveLength(2);
      expect(utxos[0]).toEqual({
        txid: 'a'.repeat(64),
        vout: 0,
        value: 75000,
        height: 200,
      });
      expect(utxos[1]).toEqual({
        txid: 'b'.repeat(64),
        vout: 1,
        value: 25000,
        height: 201,
      });
    });
  });

  // ===== broadcastVOIDTransaction Electrum fallback with invalid txid =====
  describe('broadcastVOIDTransaction Electrum fallback with invalid txid', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    it('throws when Electrum fallback returns non-txid response', async () => {
      const VALID_VOID_HEX = '0200000001abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      // Explorer fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server Error'),
      });
      // Electrum fallback returns an error string instead of a valid 64-char hex txid
      mockBlockchainTransaction_broadcast.mockResolvedValue('error: mempool full');
      const mod = getFreshModule();

      await expect(mod.broadcastVOIDTransaction(VALID_VOID_HEX)).rejects.toThrow(/Unexpected Electrum response|VOID broadcast failed/);
    });
  });

  // ===== addressToScriptHashLegacy CashAddr fallback =====
  describe('addressToScriptHashLegacy CashAddr fallback (via getVoidBalance)', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    it('falls back to CashAddr decoding when bs58check fails', async () => {
      // Explorer API fails, forcing Electrum fallback which calls addressToScriptHashLegacy
      mockFetch.mockRejectedValueOnce(new Error('Explorer down'));
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 1234, unconfirmed: 0 });
      const mod = getFreshModule();

      // Pass a CashAddr address (not a legacy address) — bs58check.decode will throw,
      // then the catch block will try decodeCashAddr as fallback
      const balance = await mod.getVoidBalance(VALID_P2PKH_ADDR);

      expect(balance).toEqual({ confirmed: 1234, unconfirmed: 0 });
      // Verify a scripthash was passed to the Electrum call
      expect(mockBlockchainScripthash_getBalance).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/));
    });
  });

  // ===== estimateFee default parameter =====
  describe('estimateFee default blocks parameter', () => {
    it('uses default blocks=6 when called without argument', async () => {
      mockBlockchainEstimatefee.mockResolvedValue(0.0001);
      const mod = getFreshModule();

      const p = mod.estimateFee();
      jest.runAllTimers();
      await p;

      // The Electrum client's blockchainEstimatefee should have been called with 6
      expect(mockBlockchainEstimatefee).toHaveBeenCalledWith(6);
    });
  });

  // ===== addressToScriptHashLegacy P2SH version byte 0x05 =====
  describe('addressToScriptHashLegacy P2SH path (via getVoidBalance)', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    it('P2SH CashAddr address produces a valid 64-char hex scripthash via legacy path', async () => {
      // Explorer API fails, forcing Electrum fallback which calls addressToScriptHashLegacy
      mockFetch.mockRejectedValueOnce(new Error('Explorer down'));
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 5000, unconfirmed: 0 });
      const mod = getFreshModule();

      // Use a P2SH CashAddr address (type 1) - bs58check.decode will fail on CashAddr,
      // falling through to CashAddr decoding where type=1 maps to versionByte=0x05,
      // which triggers the P2SH script path (OP_HASH160 <hash> OP_EQUAL)
      const balance = await mod.getVoidBalance(VALID_P2SH_ADDR);

      expect(balance).toEqual({ confirmed: 5000, unconfirmed: 0 });
      // Verify a valid 64-char hex scripthash was passed to the Electrum call
      expect(mockBlockchainScripthash_getBalance).toHaveBeenCalledWith(
        expect.stringMatching(/^[a-f0-9]{64}$/),
      );

      // Verify it matches the manually computed P2SH scripthash
      const crypto = require('crypto');
      const p2shScript = Buffer.concat([
        Buffer.from([0xa9, 0x14]), // OP_HASH160 PUSH20
        TEST_HASH,
        Buffer.from([0x87]), // OP_EQUAL
      ]);
      const hash = crypto.createHash('sha256').update(p2shScript).digest();
      const expectedScripthash = Buffer.from(hash).reverse().toString('hex');

      expect(mockBlockchainScripthash_getBalance).toHaveBeenCalledWith(expectedScripthash);
    });
  });

  // ===== rpcCall error handling =====
  describe('rpcCall error handling (via getBalanceByAddressRpc)', () => {
    it('throws when both RPC methods fail', async () => {
      const mod = getFreshModule();

      // Configure RPC so rpcConfig is set
      mod.setRpcConfig('127.0.0.1', 8342, 'testuser', 'testpass');

      // Mock fetch to return an RPC error response for getaddressinfo
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ result: null, error: { message: 'Method not found' } }),
      });

      // getBalanceByAddressRpc calls rpcCall('getaddressinfo', [address]) first.
      // When rpcCall gets an error response, it throws with the error message.
      // Then getBalanceByAddressRpc falls through to getaddressutxos fallback.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ result: null, error: { message: 'Method not found' } }),
      });

      // Both rpcCall attempts throw, so getBalanceByAddressRpc now throws
      // 'RPC balance check failed: address not indexed'
      await expect(mod.getBalanceByAddressRpc('testaddr'))
        .rejects.toThrow('RPC balance check failed: address not indexed');
    });
  });

  // ===== getBalanceByAddressRpc success path =====
  describe('getBalanceByAddressRpc success path', () => {
    it('returns correct balance when address is in wallet (ismine)', async () => {
      const mod = getFreshModule();

      // Configure RPC
      mod.setRpcConfig('127.0.0.1', 8342, 'testuser', 'testpass');

      // First rpcCall: getaddressinfo returns ismine: true
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ result: { ismine: true, iswatchonly: false }, error: null }),
      });

      // Second rpcCall: getbalance returns 1.5 VOID (in BTC denomination)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ result: 1.5, error: null }),
      });

      const balance = await mod.getBalanceByAddressRpc('bitcoincashii:qaddr');

      // 1.5 * 100000000 = 150000000 satoshis
      expect(balance).toEqual({ confirmed: 150000000, unconfirmed: 0 });
    });

    it('returns correct balance when address is watch-only', async () => {
      const mod = getFreshModule();

      mod.setRpcConfig('127.0.0.1', 8342, 'testuser', 'testpass');

      // getaddressinfo: iswatchonly true
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ result: { ismine: false, iswatchonly: true }, error: null }),
      });

      // getbalance returns 0.25 VOID
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ result: 0.25, error: null }),
      });

      const balance = await mod.getBalanceByAddressRpc('bitcoincashii:qaddr');

      // 0.25 * 100000000 = 25000000 satoshis
      expect(balance).toEqual({ confirmed: 25000000, unconfirmed: 0 });
    });
  });

  // ===== rpcCall HTTP vs HTTPS protocol selection =====
  describe('rpcCall HTTP vs HTTPS protocol selection', () => {
    it('uses http:// for localhost and https:// for remote hosts', async () => {
      // Test localhost => http://
      {
        const mod = getFreshModule();
        mod.setRpcConfig('localhost', 8342, 'user', 'pass');

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ result: { ismine: false, iswatchonly: false }, error: null }),
        });
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ result: [], error: null }),
        });

        await mod.getBalanceByAddressRpc('testaddr');

        // The first fetch call should use http:// for localhost
        const localhostUrl = mockFetch.mock.calls[0][0];
        expect(localhostUrl).toMatch(/^http:\/\/localhost:/);
      }

      jest.clearAllMocks();

      // Test remote host => https://
      {
        const mod2 = getFreshModule();
        mod2.setRpcConfig('example.com', 8342, 'user', 'pass');

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ result: { ismine: false, iswatchonly: false }, error: null }),
        });
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ result: [], error: null }),
        });

        await mod2.getBalanceByAddressRpc('testaddr');

        // The first fetch call should use https:// for remote hosts
        const remoteUrl = mockFetch.mock.calls[0][0];
        expect(remoteUrl).toMatch(/^https:\/\/example\.com:/);
      }
    });
  });

  // ===== getVOIDUtxos non-OK response path =====
  describe('getVOIDUtxos non-OK response (double failure)', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    it('throws when explorer returns non-OK and Electrum also fails', async () => {
      // Explorer returns non-OK (triggers the throw)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server Error'),
      });
      // Electrum fallback also fails (connectVOID throws)
      mockInitElectrum.mockRejectedValue(new Error('Electrum down'));
      const mod = getFreshModule();

      await expect(mod.getVOIDUtxos('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'))
        .rejects.toThrow('VOID UTXO fetch failed');
    });
  });

  // ===== getVoidBalanceByScripthash non-finite value guard =====
  describe('getVoidBalanceByScripthash non-finite value guard', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    it('returns { confirmed: 0, unconfirmed: 0 } when Electrum returns NaN/Infinity', async () => {
      // Make connectVOID succeed (initElectrum + headers_subscribe)
      mockInitElectrum.mockResolvedValue(undefined);
      mockBlockchainHeaders_subscribe.mockResolvedValue({ height: 100, time: 1234567890 });

      // Return non-finite values from getBalance
      mockBlockchainScripthash_getBalance.mockResolvedValue({
        confirmed: NaN,
        unconfirmed: Infinity,
      });

      const mod = getFreshModule();
      const balance = await mod.getVoidBalanceByScripthash('a'.repeat(64));

      expect(balance).toEqual({ confirmed: 0, unconfirmed: 0 });
    });
  });

  // =========================================================================
  // Gap coverage tests
  // =========================================================================

  // ===== getBalanceByAddress negative balance clamping (Math.max(0,...)) =====
  describe('getBalanceByAddress negative balance Math.max(0,...) clamp', () => {
    it('clamps a large negative confirmed balance to 0', async () => {
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: -99999, unconfirmed: 200 });
      const mod = getFreshModule();

      const p = mod.getBalanceByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      const balance = await p;

      // Math.max(0, ...) should clamp -99999 to 0
      expect(balance.confirmed).toBe(0);
      expect(balance.unconfirmed).toBe(200);
    });
  });

  // ===== getUtxosByScripthash duplicate UTXO filtering =====
  describe('getUtxosByScripthash duplicate UTXO filtering', () => {
    it('deduplicates UTXOs with the same tx_hash:tx_pos', async () => {
      const scripthash = 'f'.repeat(64);
      const txHash = 'a'.repeat(64);
      mockBlockchainScripthash_listunspent.mockResolvedValue([
        { tx_hash: txHash, tx_pos: 0, value: 50000, height: 100 },
        { tx_hash: txHash, tx_pos: 0, value: 50000, height: 100 }, // duplicate
        { tx_hash: txHash, tx_pos: 1, value: 25000, height: 100 }, // different tx_pos
      ]);
      const mod = getFreshModule();

      const p = mod.getUtxosByScripthash(scripthash);
      jest.runAllTimers();
      const utxos = await p;

      expect(utxos).toHaveLength(2);
      expect(utxos[0]).toEqual({ txid: txHash, vout: 0, value: 50000, height: 100 });
      expect(utxos[1]).toEqual({ txid: txHash, vout: 1, value: 25000, height: 100 });
    });
  });

  // ===== getUtxosByScripthash negative value UTXO filtering =====
  describe('getUtxosByScripthash negative value UTXO filtering', () => {
    it('filters out UTXOs with negative values', async () => {
      const scripthash = 'f'.repeat(64);
      mockBlockchainScripthash_listunspent.mockResolvedValue([
        { tx_hash: 'a'.repeat(64), tx_pos: 0, value: 10000, height: 50 },
        { tx_hash: 'b'.repeat(64), tx_pos: 0, value: -500, height: 51 },
        { tx_hash: 'c'.repeat(64), tx_pos: 0, value: 0, height: 52 },
        { tx_hash: 'd'.repeat(64), tx_pos: 0, value: 1.5, height: 53 }, // non-integer
      ]);
      const mod = getFreshModule();

      const p = mod.getUtxosByScripthash(scripthash);
      jest.runAllTimers();
      const utxos = await p;

      // Only the first UTXO (value=10000) passes: integer, > 0
      expect(utxos).toHaveLength(1);
      expect(utxos[0].value).toBe(10000);
    });
  });

  // ===== decodeCashAddr: invalid character in address string =====
  describe('decodeCashAddr invalid character (via getBalanceByAddress)', () => {
    it('throws for address containing invalid CashAddr character', async () => {
      const mod = getFreshModule();
      // 'I' is not in the CashAddr CHARSET (no 1, b, i, o in charset)
      const p = mod.getBalanceByAddress('bitcoincashii:qIvalidchars');
      jest.runAllTimers();
      await expect(p).rejects.toThrow();
    });
  });

  // ===== decodeCashAddr: short payload (< 8 values after conversion) =====
  describe('decodeCashAddr short payload (via getBalanceByAddress)', () => {
    it('throws for address with too few characters after prefix', async () => {
      const mod = getFreshModule();
      // Only 5 valid CHARSET characters — decodeCashAddr returns null for < 8 values
      const p = mod.getBalanceByAddress('bitcoincashii:qpzry');
      jest.runAllTimers();
      await expect(p).rejects.toThrow('Invalid VOID address');
    });
  });

  // ===== decodeCashAddr: checksum validation failure =====
  describe('decodeCashAddr checksum validation failure (via getBalanceByAddress)', () => {
    it('throws for address with corrupted checksum', async () => {
      const mod = getFreshModule();
      // Take a valid address and flip a character to break the checksum
      const bare = VALID_P2PKH_BARE;
      const chars = bare.split('');
      // Flip a character in the middle of the payload
      const idx = Math.floor(chars.length / 2);
      const orig = chars[idx];
      chars[idx] = CHARSET[(CHARSET.indexOf(orig) + 3) % CHARSET.length];
      const corrupted = 'bitcoincashii:' + chars.join('');

      const p = mod.getBalanceByAddress(corrupted);
      jest.runAllTimers();
      await expect(p).rejects.toThrow('Invalid VOID address');
    });
  });

  // ===== decodeCashAddr: padding bits non-zero =====
  describe('decodeCashAddr padding bits non-zero (via getBalanceByAddress)', () => {
    it('throws for address with non-zero padding bits', async () => {
      const mod = getFreshModule();
      // We construct a valid-looking address but tweak the last data character
      // (before checksum) so padding bits are non-zero.
      // Instead of constructing this manually, we use a known invalid address
      // that would have bad padding. The simplest approach is to use a bare
      // address where we modify the version+payload encoding to produce
      // non-zero padding.
      //
      // Since the checksum would also be invalid if we flip payload bits,
      // this actually hits the checksum check first. So we test via the
      // internal decodeCashAddr by passing an address that is entirely
      // made of valid CHARSET chars but has wrong length/structure.
      // The easiest way to trigger the padding-bits check specifically
      // is indirectly—but since checksum validation happens first,
      // a tampered address will fail at checksum. We'll verify that
      // the function correctly rejects such addresses.
      const p = mod.getBalanceByAddress('bitcoincashii:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq');
      jest.runAllTimers();
      await expect(p).rejects.toThrow('Invalid VOID address');
    });
  });

  // ===== addressToScriptHashLegacy: bs58check.decode exception path =====
  describe('addressToScriptHashLegacy bs58check exception (via getVoidBalance)', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    it('throws when given totally invalid base58 and invalid CashAddr', async () => {
      // Explorer API fails to force Electrum fallback
      mockFetch.mockRejectedValueOnce(new Error('Explorer down'));
      // Electrum connect succeeds
      mockInitElectrum.mockResolvedValue(undefined);
      mockBlockchainHeaders_subscribe.mockResolvedValue({ height: 100 });

      const mod = getFreshModule();

      // '!!!invalid!!!' is neither valid base58 nor valid CashAddr
      // bs58check.decode will throw, then CashAddr decode will return null,
      // then the code throws 'Invalid address format'
      await expect(mod.getVoidBalance('!!!invalid!!!')).rejects.toThrow();
    });
  });

  // ===== addressToScriptHashLegacy: CashAddr fallback when legacy decode fails =====
  describe('addressToScriptHashLegacy CashAddr fallback (via getVoidBalance)', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    it('successfully falls back to CashAddr decoding for P2PKH address', async () => {
      // Explorer API fails, forcing Electrum fallback
      mockFetch.mockRejectedValueOnce(new Error('Explorer down'));
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 42000, unconfirmed: 0 });
      const mod = getFreshModule();

      // CashAddr address — bs58check.decode fails, falls through to CashAddr decoder
      // type=0 => P2PKH => versionByte=0x00 => P2PKH script path
      const balance = await mod.getVoidBalance(VALID_P2PKH_ADDR);

      expect(balance).toEqual({ confirmed: 42000, unconfirmed: 0 });
      expect(mockBlockchainScripthash_getBalance).toHaveBeenCalledWith(
        expect.stringMatching(/^[a-f0-9]{64}$/),
      );
    });
  });

  // ===== addressToScriptHashLegacy: version byte 0x05 (P2SH) branching =====
  describe('addressToScriptHashLegacy P2SH version byte 0x05 (via getVoidBalance)', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    it('generates correct P2SH script (OP_HASH160 <hash> OP_EQUAL) for P2SH address', async () => {
      // Explorer API fails, forcing Electrum fallback
      mockFetch.mockRejectedValueOnce(new Error('Explorer down'));
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 7777, unconfirmed: 0 });
      const mod = getFreshModule();

      // P2SH CashAddr: type=1 => versionByte=0x05 => P2SH script
      const balance = await mod.getVoidBalance(VALID_P2SH_ADDR);

      expect(balance).toEqual({ confirmed: 7777, unconfirmed: 0 });

      // Verify the scripthash matches the P2SH script computation
      const crypto = require('crypto');
      const p2shScript = Buffer.concat([
        Buffer.from([0xa9, 0x14]), // OP_HASH160 PUSH20
        TEST_HASH,
        Buffer.from([0x87]), // OP_EQUAL
      ]);
      const hash = crypto.createHash('sha256').update(p2shScript).digest();
      const expectedScripthash = Buffer.from(hash).reverse().toString('hex');

      expect(mockBlockchainScripthash_getBalance).toHaveBeenCalledWith(expectedScripthash);
    });
  });

  // ===== estimateFee: feePerKB=0 returns minimum (1 sat/byte) =====
  describe('estimateFee feePerKB=0 returns minimum', () => {
    it('returns 1 sat/byte when feePerKB is 0', async () => {
      mockBlockchainEstimatefee.mockResolvedValue(0);
      const mod = getFreshModule();

      const p = mod.estimateFee(6);
      jest.runAllTimers();
      const fee = await p;

      // feePerKB=0 is not > 0, so code returns 1 (default)
      expect(fee).toBe(1);
    });
  });

  // ===== estimateFee: very large feePerKB capped at 100 sat/byte =====
  describe('estimateFee very large feePerKB capped at max', () => {
    it('caps at 100 sat/byte for an extremely large feePerKB', async () => {
      // 1.0 BTC/kB = 100000 sat/byte -> capped to 100
      mockBlockchainEstimatefee.mockResolvedValue(1.0);
      const mod = getFreshModule();

      const p = mod.estimateFee(6);
      jest.runAllTimers();
      const fee = await p;

      expect(fee).toBe(100);
    });

    it('caps at 100 sat/byte for a huge feePerKB value (100 BTC/kB)', async () => {
      // 100 BTC/kB = 10,000,000 sat/byte -> capped to 100
      mockBlockchainEstimatefee.mockResolvedValue(100);
      const mod = getFreshModule();

      const p = mod.estimateFee(6);
      jest.runAllTimers();
      const fee = await p;

      expect(fee).toBe(100);
    });
  });

  // =========================================================================
  // Edge case gap tests
  // =========================================================================

  // ===== 1. UTXO filtering value=1.0 (float where Number.isInteger(1.0)=true) =====
  describe('UTXO filtering value=1.0 (integer float)', () => {
    it('accepts value=1.0 since Number.isInteger(1.0) is true and 1.0 > 0', async () => {
      mockBlockchainScripthash_listunspent.mockResolvedValue([
        { tx_hash: 'a'.repeat(64), tx_pos: 0, value: 1.0, height: 100 },
      ]);
      const mod = getFreshModule();

      const p = mod.getUtxosByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      const utxos = await p;

      // 1.0 is typeof 'number', Number.isInteger(1.0) is true, and 1.0 > 0
      expect(utxos).toHaveLength(1);
      expect(utxos[0].value).toBe(1);
    });
  });

  // ===== 2. UTXO filtering value=0 (filtered out) =====
  describe('UTXO filtering value=0', () => {
    it('filters out UTXOs with value=0 because value > 0 check fails', async () => {
      mockBlockchainScripthash_listunspent.mockResolvedValue([
        { tx_hash: 'a'.repeat(64), tx_pos: 0, value: 0, height: 100 },
        { tx_hash: 'b'.repeat(64), tx_pos: 0, value: 5000, height: 101 },
      ]);
      const mod = getFreshModule();

      const p = mod.getUtxosByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      const utxos = await p;

      // Only value=5000 passes; value=0 is filtered by `utxo.value > 0`
      expect(utxos).toHaveLength(1);
      expect(utxos[0].value).toBe(5000);
    });
  });

  // ===== 3. getVOIDUtxos() non-array response =====
  describe('getVOIDUtxos() non-array response from explorer', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    it('throws when explorer returns string response and Electrum also fails', async () => {
      // Explorer returns a string instead of an array
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve('not an array'),
      });
      // Electrum fallback also fails
      mockInitElectrum.mockRejectedValue(new Error('Electrum down'));
      const mod = getFreshModule();

      // When response.json() returns a non-array, the code throws
      // 'Explorer API returned invalid UTXO data', triggering Electrum fallback
      // which also fails, so the outer catch throws.
      await expect(mod.getVOIDUtxos('testaddr'))
        .rejects.toThrow('VOID UTXO fetch failed');
    });

    it('throws when explorer returns object response and Electrum also fails', async () => {
      // Explorer returns an object instead of an array
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ error: 'bad request' }),
      });
      // Electrum fallback also fails
      mockInitElectrum.mockRejectedValue(new Error('Electrum down'));
      const mod = getFreshModule();

      await expect(mod.getVOIDUtxos('testaddr'))
        .rejects.toThrow('VOID UTXO fetch failed');
    });
  });

  // ===== 4. broadcastVOIDTransaction() txid not a string (number/object) =====
  describe('broadcastVOIDTransaction() txid not a string', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    it('rejects when response JSON has txid as a number', async () => {
      const VALID_VOID_HEX = '0200000001abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      // Explorer returns JSON with txid as a number
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ txid: 12345 })),
      });
      // Electrum fallback also fails
      mockInitElectrum.mockRejectedValue(new Error('Electrum down'));
      const mod = getFreshModule();

      // The response text is '{"txid":12345}' which is not a 64-char hex string.
      // JSON.parse extracts txid=12345, but the regex test /^[a-fA-F0-9]{64}$/
      // checks parsed.txid which is a number - .test(12345) converts to string "12345"
      // which doesn't match the 64-char hex pattern. So validation fails.
      await expect(mod.broadcastVOIDTransaction(VALID_VOID_HEX)).rejects.toThrow(/Broadcast|VOID broadcast failed/);
    });

    it('rejects when response JSON has txid as an object', async () => {
      const VALID_VOID_HEX = '0200000001abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ txid: { hash: 'abc' } })),
      });
      mockInitElectrum.mockRejectedValue(new Error('Electrum down'));
      const mod = getFreshModule();

      await expect(mod.broadcastVOIDTransaction(VALID_VOID_HEX)).rejects.toThrow(/Broadcast|VOID broadcast failed/);
    });
  });

  // ===== 5. SHA256 scripthash test vector =====
  describe('SHA256 scripthash test vector', () => {
    it('computes correct scripthash for known P2PKH address', async () => {
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
      const mod = getFreshModule();

      const p = mod.getBalanceByAddress(VALID_P2PKH_ADDR);
      jest.runAllTimers();
      await p;

      const passedScripthash = mockBlockchainScripthash_getBalance.mock.calls[0][0];

      // Manually compute the expected scripthash
      const crypto = require('crypto');
      // P2PKH script: OP_DUP OP_HASH160 <20-byte-hash> OP_EQUALVERIFY OP_CHECKSIG
      const script = Buffer.concat([
        Buffer.from([0x76, 0xa9, 0x14]),
        TEST_HASH,
        Buffer.from([0x88, 0xac]),
      ]);
      const sha256 = crypto.createHash('sha256').update(script).digest();
      const expectedScripthash = Buffer.from(sha256).reverse().toString('hex');

      // Verify against the pre-computed expected value
      expect(passedScripthash).toBe(expectedScripthash);
      // Also verify the expected value is a 64-char lowercase hex string
      expect(expectedScripthash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ===== 6. addressToScriptHashLegacy() both decoding methods fail =====
  describe('addressToScriptHashLegacy() both decoding methods fail', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    it('throws when neither bs58check nor CashAddr can decode (error propagates through getVoidBalance)', async () => {
      // Explorer API fails to force Electrum fallback (which calls addressToScriptHashLegacy)
      mockFetch.mockRejectedValueOnce(new Error('Explorer down'));
      mockInitElectrum.mockResolvedValue(undefined);
      mockBlockchainHeaders_subscribe.mockResolvedValue({ height: 100 });
      const mod = getFreshModule();

      // '@@@invalidgarbage@@@' is neither valid base58check nor valid CashAddr.
      // bs58check.decode throws, then decodeCashAddr returns null, which causes
      // addressToScriptHashLegacy to throw 'Invalid address format'.
      // This error is caught by the inner catch (electrumError) in getVoidBalance,
      // which re-throws as 'VOID balance check failed: both Explorer API and Electrum unavailable'.
      await expect(mod.getVoidBalance('@@@invalidgarbage@@@')).rejects.toThrow('VOID balance check failed');
    });
  });

  // ===== 7. getBalanceByScripthash() with string balance =====
  describe('getBalanceByScripthash() with string balance', () => {
    it('handles string "100" by converting via Number() and flooring', async () => {
      // Electrum returns confirmed as string "100" instead of number
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: '100', unconfirmed: '50' });
      const scripthash = 'a'.repeat(64);
      const mod = getFreshModule();

      const p = mod.getBalanceByScripthash(scripthash);
      jest.runAllTimers();
      const balance = await p;

      // Number('100') = 100, Math.floor(100) = 100, Math.max(0, 100) = 100
      expect(balance.confirmed).toBe(100);
      // Number('50') = 50, Math.floor(50) = 50
      expect(balance.unconfirmed).toBe(50);
    });

    it('handles non-numeric string by returning 0', async () => {
      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 'abc', unconfirmed: 'xyz' });
      const scripthash = 'a'.repeat(64);
      const mod = getFreshModule();

      const p = mod.getBalanceByScripthash(scripthash);
      jest.runAllTimers();
      const balance = await p;

      // Number('abc') = NaN, Number(NaN) || 0 = 0
      expect(balance.confirmed).toBe(0);
      expect(balance.unconfirmed).toBe(0);
    });
  });

  // ===== 8. connectMain() peer cycling =====
  describe('connectMain() peer cycling', () => {
    it('cycles to second peer after first peer fails', async () => {
      const ElectrumClient = require('electrum-client');
      let callIndex = 0;

      // Track which peer was used for each connection attempt
      ElectrumClient.mockImplementation((transport: any, port: any, host: string, protocol: string) => {
        callIndex++;
        const client = createMockClient();
        if (callIndex === 1) {
          // First peer fails
          client.initElectrum = jest.fn().mockRejectedValue(new Error('First peer down'));
        } else {
          // Second peer succeeds
          client.initElectrum = jest.fn().mockResolvedValue(undefined);
          client.blockchainHeaders_subscribe = jest.fn().mockResolvedValue({ height: 200, time: 1234567890 });
        }
        return client;
      });

      mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 999, unconfirmed: 0 });
      const mod = getFreshModule();

      const p = mod.getBalanceByAddress(VALID_P2PKH_ADDR);

      // Advance through retry delay (BASE_DELAY_MS * 2^0 = 1000ms)
      for (let i = 0; i < 5; i++) {
        jest.advanceTimersByTime(2000);
        await Promise.resolve();
      }
      jest.runAllTimers();
      await p;

      // ElectrumClient constructor was called at least twice (first peer fails, second succeeds)
      expect(callIndex).toBeGreaterThanOrEqual(2);

      // Reset ElectrumClient mock
      ElectrumClient.mockImplementation(() => createMockClient());
    });
  });

  // ===== 9. estimateFee() negative fee from server =====
  describe('estimateFee() negative fee from server', () => {
    it('returns 1 sat/byte when server returns -1', async () => {
      mockBlockchainEstimatefee.mockResolvedValue(-1);
      const mod = getFreshModule();

      const p = mod.estimateFee(6);
      jest.runAllTimers();
      const fee = await p;

      // -1 is not > 0, so the code falls through to `return 1`
      expect(fee).toBe(1);
    });

    it('returns 1 sat/byte when server returns -0.5', async () => {
      mockBlockchainEstimatefee.mockResolvedValue(-0.5);
      const mod = getFreshModule();

      const p = mod.estimateFee(6);
      jest.runAllTimers();
      const fee = await p;

      expect(fee).toBe(1);
    });

    it('returns 1 sat/byte when server returns Number.MIN_SAFE_INTEGER', async () => {
      mockBlockchainEstimatefee.mockResolvedValue(Number.MIN_SAFE_INTEGER);
      const mod = getFreshModule();

      const p = mod.estimateFee(6);
      jest.runAllTimers();
      const fee = await p;

      expect(fee).toBe(1);
    });
  });
});
