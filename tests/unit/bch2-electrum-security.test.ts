/**
 * VOID Electrum Module - Security Hardening Tests
 *
 * Tests UTXO validation, input sanitization, address validation,
 * coinbase maturity checks, and header validation in VoidElectrum.ts.
 */

// --- Mock Setup ---

const mockInitElectrum = jest.fn();
const mockBlockchainHeaders_subscribe = jest.fn();
const mockBlockchainScripthash_getBalance = jest.fn();
const mockBlockchainScripthash_listunspent = jest.fn();
const mockBlockchainTransaction_get = jest.fn();
const mockBlockchainEstimatefee = jest.fn();
const mockBlockchainTransaction_broadcast = jest.fn();
const mockClose = jest.fn();

function createMockClient() {
  return {
    initElectrum: mockInitElectrum,
    blockchainHeaders_subscribe: mockBlockchainHeaders_subscribe,
    blockchainScripthash_getBalance: mockBlockchainScripthash_getBalance,
    blockchainScripthash_listunspent: mockBlockchainScripthash_listunspent,
    blockchainTransaction_get: mockBlockchainTransaction_get,
    blockchainEstimatefee: mockBlockchainEstimatefee,
    blockchainTransaction_broadcast: mockBlockchainTransaction_broadcast,
    close: mockClose,
    onError: null as any,
    onClose: null as any,
  };
}

jest.mock('electrum-client', () => jest.fn().mockImplementation(() => createMockClient()));
jest.mock('react-native-default-preference', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
}));

// Valid 64-char hex scripthash for tests
const VALID_SCRIPTHASH = 'a'.repeat(64);
// Valid 64-char hex txid
const VALID_TXID = 'b'.repeat(64);

/**
 * Helper: import the VoidElectrum module within jest.isolateModules so each
 * test group gets a fresh module state (fresh connection flags, client refs, etc.).
 * Before returning the module, it drives connectMain() by making the mocks
 * resolve successfully so functions that need a connection can proceed.
 */
async function getConnectedModule() {
  let mod: any;
  await new Promise<void>((resolve, reject) => {
    jest.isolateModules(() => {
      try {
        // Reset mocks before each isolated import
        mockInitElectrum.mockReset().mockResolvedValue(undefined);
        mockBlockchainHeaders_subscribe.mockReset().mockResolvedValue({ height: 1000 });
        mockBlockchainScripthash_getBalance.mockReset();
        mockBlockchainScripthash_listunspent.mockReset();
        mockBlockchainTransaction_get.mockReset();
        mockBlockchainEstimatefee.mockReset();
        mockBlockchainTransaction_broadcast.mockReset();
        mockClose.mockReset();

        mod = require('../../blue_modules/VoidElectrum');
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
  return mod;
}

// =====================================================================
// UTXO Validation
// =====================================================================
describe('VoidElectrum Security - UTXO Validation', () => {
  // Helper: call getUtxosByScripthash with mocked listunspent response
  async function callGetUtxos(utxoResponse: any): Promise<any[]> {
    const mod = await getConnectedModule();
    mockBlockchainScripthash_listunspent.mockResolvedValue(utxoResponse);
    return mod.getUtxosByScripthash(VALID_SCRIPTHASH);
  }

  it('1. filters out UTXOs with non-hex txid', async () => {
    const result = await callGetUtxos([
      { tx_hash: 'not-a-hex-string!@#$', value: 50000, tx_pos: 0, height: 100 },
      { tx_hash: 'ZZZZ' + 'a'.repeat(60), value: 50000, tx_pos: 0, height: 100 },
      { tx_hash: VALID_TXID, value: 50000, tx_pos: 1, height: 100 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].txid).toBe(VALID_TXID);
  });

  it('2. filters out UTXOs with negative value', async () => {
    const result = await callGetUtxos([
      { tx_hash: VALID_TXID, value: -1, tx_pos: 0, height: 100 },
      { tx_hash: VALID_TXID, value: -100000, tx_pos: 1, height: 100 },
      { tx_hash: VALID_TXID, value: 50000, tx_pos: 2, height: 100 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(50000);
    expect(result[0].vout).toBe(2);
  });

  it('3. filters out UTXOs with value exceeding 21M BTC supply cap', async () => {
    const MAX_SUPPLY_SATS = 21_000_000 * 100_000_000; // 2.1 quadrillion sats
    const result = await callGetUtxos([
      { tx_hash: VALID_TXID, value: MAX_SUPPLY_SATS + 1, tx_pos: 0, height: 100 },
      { tx_hash: VALID_TXID, value: Number.MAX_SAFE_INTEGER, tx_pos: 1, height: 100 },
      { tx_hash: VALID_TXID, value: MAX_SUPPLY_SATS, tx_pos: 2, height: 100 }, // exactly at cap is OK
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(MAX_SUPPLY_SATS);
  });

  it('4. filters out UTXOs with non-integer vout (tx_pos)', async () => {
    const result = await callGetUtxos([
      { tx_hash: VALID_TXID, value: 50000, tx_pos: 1.5, height: 100 },
      { tx_hash: VALID_TXID, value: 50000, tx_pos: NaN, height: 100 },
      { tx_hash: VALID_TXID, value: 50000, tx_pos: 'zero' as any, height: 100 },
      { tx_hash: VALID_TXID, value: 60000, tx_pos: 0, height: 100 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].vout).toBe(0);
    expect(result[0].value).toBe(60000);
  });

  it('5. filters out UTXOs with vout > 0xFFFFFFFF', async () => {
    const result = await callGetUtxos([
      { tx_hash: VALID_TXID, value: 50000, tx_pos: 0xFFFFFFFF + 1, height: 100 },
      { tx_hash: VALID_TXID, value: 50000, tx_pos: 0x100000000, height: 100 },
      { tx_hash: VALID_TXID, value: 50000, tx_pos: -1, height: 100 },
      { tx_hash: VALID_TXID, value: 50000, tx_pos: 0xFFFFFFFF, height: 100 }, // exactly at limit OK
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].vout).toBe(0xFFFFFFFF);
  });

  it('6. filters out duplicate UTXOs (same txid:vout)', async () => {
    const result = await callGetUtxos([
      { tx_hash: VALID_TXID, value: 50000, tx_pos: 0, height: 100 },
      { tx_hash: VALID_TXID, value: 50000, tx_pos: 0, height: 100 }, // duplicate
      { tx_hash: VALID_TXID, value: 50000, tx_pos: 0, height: 200 }, // duplicate with diff height
      { tx_hash: VALID_TXID, value: 60000, tx_pos: 1, height: 100 }, // different vout, not duplicate
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].vout).toBe(0);
    expect(result[1].vout).toBe(1);
  });

  it('7. defaults height to 0 for non-integer heights', async () => {
    const result = await callGetUtxos([
      { tx_hash: VALID_TXID, value: 50000, tx_pos: 0, height: 'not-a-number' },
      { tx_hash: VALID_TXID, value: 60000, tx_pos: 1, height: -1 },
      { tx_hash: VALID_TXID, value: 70000, tx_pos: 2, height: 3.14 },
      { tx_hash: VALID_TXID, value: 80000, tx_pos: 3, height: undefined },
      { tx_hash: VALID_TXID, value: 90000, tx_pos: 4, height: null },
      { tx_hash: VALID_TXID, value: 100000, tx_pos: 5, height: 500 }, // valid height
    ]);
    expect(result).toHaveLength(6);
    // All invalid heights should default to 0
    expect(result[0].height).toBe(0);
    expect(result[1].height).toBe(0);
    expect(result[2].height).toBe(0);
    expect(result[3].height).toBe(0);
    expect(result[4].height).toBe(0);
    // Valid height preserved
    expect(result[5].height).toBe(500);
  });

  it('8. returns empty array for non-array response', async () => {
    // null response
    let result = await callGetUtxos(null);
    expect(result).toEqual([]);

    // undefined response
    result = await callGetUtxos(undefined);
    expect(result).toEqual([]);

    // object response
    result = await callGetUtxos({ some: 'object' });
    expect(result).toEqual([]);

    // string response
    result = await callGetUtxos('not an array');
    expect(result).toEqual([]);

    // number response
    result = await callGetUtxos(42);
    expect(result).toEqual([]);
  });
});

// =====================================================================
// Input Validation
// =====================================================================
describe('VoidElectrum Security - Input Validation', () => {
  it('9. getUtxosByScripthash rejects non-64-char-hex scripthash', async () => {
    const mod = await getConnectedModule();

    // Too short
    await expect(mod.getUtxosByScripthash('abcdef')).rejects.toThrow('Invalid scripthash');

    // Too long
    await expect(mod.getUtxosByScripthash('a'.repeat(65))).rejects.toThrow('Invalid scripthash');

    // Non-hex characters
    await expect(mod.getUtxosByScripthash('g'.repeat(64))).rejects.toThrow('Invalid scripthash');

    // Empty string
    await expect(mod.getUtxosByScripthash('')).rejects.toThrow('Invalid scripthash');

    // Correct length but with spaces
    await expect(mod.getUtxosByScripthash(' '.repeat(64))).rejects.toThrow('Invalid scripthash');

    // Number input
    await expect(mod.getUtxosByScripthash(12345 as any)).rejects.toThrow('Invalid scripthash');

    // null input
    await expect(mod.getUtxosByScripthash(null as any)).rejects.toThrow('Invalid scripthash');
  });

  it('10. estimateFee rejects non-integer block count (defaults to 6)', async () => {
    const mod = await getConnectedModule();
    // Mock a fee response: 0.00001 BTC/kB = 1 sat/byte
    mockBlockchainEstimatefee.mockResolvedValue(0.00001);

    // Float - should default to 6 blocks
    await mod.estimateFee(3.5);
    expect(mockBlockchainEstimatefee).toHaveBeenLastCalledWith(6);

    // NaN - should default to 6 blocks
    mockBlockchainEstimatefee.mockClear();
    await mod.estimateFee(NaN);
    expect(mockBlockchainEstimatefee).toHaveBeenLastCalledWith(6);

    // Negative - should default to 6 blocks
    mockBlockchainEstimatefee.mockClear();
    await mod.estimateFee(-1);
    expect(mockBlockchainEstimatefee).toHaveBeenLastCalledWith(6);

    // Zero - should default to 6 blocks
    mockBlockchainEstimatefee.mockClear();
    await mod.estimateFee(0);
    expect(mockBlockchainEstimatefee).toHaveBeenLastCalledWith(6);

    // String - should default to 6 blocks
    mockBlockchainEstimatefee.mockClear();
    await mod.estimateFee('ten' as any);
    expect(mockBlockchainEstimatefee).toHaveBeenLastCalledWith(6);
  });

  it('11. estimateFee caps block count at 144', async () => {
    const mod = await getConnectedModule();
    mockBlockchainEstimatefee.mockResolvedValue(0.00001);

    await mod.estimateFee(200);
    expect(mockBlockchainEstimatefee).toHaveBeenLastCalledWith(144);

    mockBlockchainEstimatefee.mockClear();
    await mod.estimateFee(1000);
    expect(mockBlockchainEstimatefee).toHaveBeenLastCalledWith(144);

    // Exactly 144 should be fine
    mockBlockchainEstimatefee.mockClear();
    await mod.estimateFee(144);
    expect(mockBlockchainEstimatefee).toHaveBeenLastCalledWith(144);

    // 143 should pass through uncapped
    mockBlockchainEstimatefee.mockClear();
    await mod.estimateFee(143);
    expect(mockBlockchainEstimatefee).toHaveBeenLastCalledWith(143);
  });

  it('12. estimateFee returns 1 for non-finite fee response (NaN, Infinity)', async () => {
    const mod = await getConnectedModule();

    // NaN response
    mockBlockchainEstimatefee.mockResolvedValue(NaN);
    let fee = await mod.estimateFee(6);
    expect(fee).toBe(1);

    // Infinity response
    mockBlockchainEstimatefee.mockResolvedValue(Infinity);
    fee = await mod.estimateFee(6);
    expect(fee).toBe(1);

    // -Infinity response
    mockBlockchainEstimatefee.mockResolvedValue(-Infinity);
    fee = await mod.estimateFee(6);
    expect(fee).toBe(1);

    // Negative fee
    mockBlockchainEstimatefee.mockResolvedValue(-0.001);
    fee = await mod.estimateFee(6);
    expect(fee).toBe(1);

    // Zero fee
    mockBlockchainEstimatefee.mockResolvedValue(0);
    fee = await mod.estimateFee(6);
    expect(fee).toBe(1);

    // String response
    mockBlockchainEstimatefee.mockResolvedValue('not-a-number');
    fee = await mod.estimateFee(6);
    expect(fee).toBe(1);

    // null response
    mockBlockchainEstimatefee.mockResolvedValue(null);
    fee = await mod.estimateFee(6);
    expect(fee).toBe(1);
  });

  it('13. estimateFee caps fee at 100 sat/byte', async () => {
    const mod = await getConnectedModule();

    // 0.01 BTC/kB = 1000 sat/byte -- should be capped to 100
    mockBlockchainEstimatefee.mockResolvedValue(0.01);
    let fee = await mod.estimateFee(6);
    expect(fee).toBe(100);

    // 1 BTC/kB = 100000 sat/byte -- should be capped to 100
    mockBlockchainEstimatefee.mockResolvedValue(1.0);
    fee = await mod.estimateFee(6);
    expect(fee).toBe(100);

    // Just under cap: 0.001 BTC/kB = 100 sat/byte
    mockBlockchainEstimatefee.mockResolvedValue(0.001);
    fee = await mod.estimateFee(6);
    expect(fee).toBe(100);

    // Normal fee: 0.00001 BTC/kB = 1 sat/byte
    mockBlockchainEstimatefee.mockResolvedValue(0.00001);
    fee = await mod.estimateFee(6);
    expect(fee).toBe(1);

    // Small positive fee: 0.000005 BTC/kB = 0.5 sat/byte -> ceiled to 1
    mockBlockchainEstimatefee.mockResolvedValue(0.000005);
    fee = await mod.estimateFee(6);
    expect(fee).toBeGreaterThanOrEqual(1);
    expect(fee).toBeLessThanOrEqual(100);
  });

  it('14. broadcastTransaction rejects non-hex strings', async () => {
    const mod = await getConnectedModule();

    await expect(mod.broadcastTransaction('not-hex-at-all!')).rejects.toThrow('Invalid transaction hex');
    await expect(mod.broadcastTransaction('ZZZZ1234567890abcdef12')).rejects.toThrow('Invalid transaction hex');
    await expect(mod.broadcastTransaction(12345 as any)).rejects.toThrow('Invalid transaction hex');
    await expect(mod.broadcastTransaction(null as any)).rejects.toThrow('Invalid transaction hex');
    await expect(mod.broadcastTransaction(undefined as any)).rejects.toThrow('Invalid transaction hex');
  });

  it('15. broadcastTransaction rejects too-short hex', async () => {
    const mod = await getConnectedModule();

    // Less than 20 chars (minimum tx = 10 bytes = 20 hex chars)
    await expect(mod.broadcastTransaction('abcdef')).rejects.toThrow('Invalid transaction hex');
    await expect(mod.broadcastTransaction('aabbccdd')).rejects.toThrow('Invalid transaction hex');
    await expect(mod.broadcastTransaction('a'.repeat(18))).rejects.toThrow('Invalid transaction hex');

    // Exactly 19 chars (odd length still fails the hex regex test for valid tx format)
    await expect(mod.broadcastTransaction('a'.repeat(19))).rejects.toThrow();
  });

  it('16. broadcastTransaction rejects too-long hex (> 4M chars)', async () => {
    const mod = await getConnectedModule();

    // 4_000_001 chars -- just over the limit
    const tooLong = 'a'.repeat(4_000_001);
    await expect(mod.broadcastTransaction(tooLong)).rejects.toThrow('Invalid transaction hex');
  });

  it('17. setRpcConfig rejects invalid port (0, 65536, non-integer)', async () => {
    const mod = await getConnectedModule();

    expect(() => mod.setRpcConfig('localhost', 0, 'user', 'pass')).toThrow('Invalid RPC port');
    expect(() => mod.setRpcConfig('localhost', 65536, 'user', 'pass')).toThrow('Invalid RPC port');
    expect(() => mod.setRpcConfig('localhost', -1, 'user', 'pass')).toThrow('Invalid RPC port');
    expect(() => mod.setRpcConfig('localhost', 3.14, 'user', 'pass')).toThrow('Invalid RPC port');
    expect(() => mod.setRpcConfig('localhost', NaN, 'user', 'pass')).toThrow('Invalid RPC port');
    expect(() => mod.setRpcConfig('localhost', Infinity, 'user', 'pass')).toThrow('Invalid RPC port');
    expect(() => mod.setRpcConfig('localhost', '8332' as any, 'user', 'pass')).toThrow('Invalid RPC port');

    // Valid ports should not throw
    expect(() => mod.setRpcConfig('localhost', 1, 'user', 'pass')).not.toThrow();
    expect(() => mod.setRpcConfig('localhost', 8332, 'user', 'pass')).not.toThrow();
    expect(() => mod.setRpcConfig('localhost', 65535, 'user', 'pass')).not.toThrow();
  });

  it('18. setRpcConfig rejects empty host', async () => {
    const mod = await getConnectedModule();

    expect(() => mod.setRpcConfig('', 8332, 'user', 'pass')).toThrow('Invalid RPC host');
    expect(() => mod.setRpcConfig(null as any, 8332, 'user', 'pass')).toThrow();
    expect(() => mod.setRpcConfig(undefined as any, 8332, 'user', 'pass')).toThrow();

    // Valid host should not throw
    expect(() => mod.setRpcConfig('127.0.0.1', 8332, 'user', 'pass')).not.toThrow();
  });
});

// =====================================================================
// Address Validation (tested indirectly through getBalanceByAddress)
// =====================================================================
describe('VoidElectrum Security - Address Validation', () => {
  it('19. addressToScriptHash (via getBalanceByAddress) rejects empty string', async () => {
    const mod = await getConnectedModule();

    await expect(mod.getBalanceByAddress('')).rejects.toThrow(/[Ii]nvalid/);
  });

  it('20. addressToScriptHash (via getBalanceByAddress) rejects bitcoincash: prefix (BCH not VOID)', async () => {
    const mod = await getConnectedModule();

    // BCH CashAddr prefix should be rejected (cross-chain confusion attack)
    await expect(
      mod.getBalanceByAddress('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'),
    ).rejects.toThrow(/wrong prefix/);

    // bchtest: prefix should also be rejected
    await expect(
      mod.getBalanceByAddress('bchtest:qpm2qsznhks23z7629mms6s4cwef74vcwvhanqgjxu'),
    ).rejects.toThrow(/wrong prefix/);
  });

  it('20b. getBalanceByScripthash also validates scripthash format', async () => {
    const mod = await getConnectedModule();

    await expect(mod.getBalanceByScripthash('')).rejects.toThrow('Invalid scripthash');
    await expect(mod.getBalanceByScripthash('tooshort')).rejects.toThrow('Invalid scripthash');
    await expect(mod.getBalanceByScripthash('g'.repeat(64))).rejects.toThrow('Invalid scripthash');
  });
});

// =====================================================================
// Coinbase Maturity
// =====================================================================
describe('VoidElectrum Security - Coinbase Maturity', () => {
  it('21. isCoinbaseTx rejects raw hex shorter than 74 chars', async () => {
    const mod = await getConnectedModule();

    // Mock getRawTransaction to return short hex
    const shortHex = 'aabbccdd0011223344556677'; // 24 chars < 74
    mockBlockchainTransaction_get.mockResolvedValue(shortHex);

    await expect(mod.isCoinbaseTx(VALID_TXID)).rejects.toThrow('Raw transaction too short');
  });

  it('22. isCoinbaseTx correctly identifies coinbase (all-zero prevout hash)', async () => {
    const mod = await getConnectedModule();

    // Build a raw coinbase tx hex:
    // version (4 bytes = 8 hex chars): 01000000
    // input count (varint 1 byte = 2 hex): 01
    // prevout hash (32 bytes = 64 hex): 0000...0000 (coinbase marker)
    // prevout index (4 bytes = 8 hex): ffffffff
    // scriptsig length (varint): 04
    // scriptsig: deadbeef
    // sequence: ffffffff
    // output count: 01
    // value (8 bytes): 0000000000000000
    // scriptpubkey length: 00
    // locktime: 00000000
    const coinbaseHex =
      '01000000' + // version
      '01' + // 1 input
      '0'.repeat(64) + // prevout hash (all zeros = coinbase)
      'ffffffff' + // prevout index
      '04' + // scriptsig length
      'deadbeef' + // scriptsig
      'ffffffff' + // sequence
      '01' + // 1 output
      '0000000000000000' + // value
      '00' + // scriptpubkey length
      '00000000'; // locktime

    mockBlockchainTransaction_get.mockResolvedValue(coinbaseHex);

    const result = await mod.isCoinbaseTx(VALID_TXID);
    expect(result).toBe(true);
  });

  it('23. isCoinbaseTx correctly identifies non-coinbase tx', async () => {
    const mod = await getConnectedModule();

    // Same structure but with a non-zero prevout hash
    const nonCoinbaseHex =
      '01000000' + // version
      '01' + // 1 input
      'abcdef'.repeat(10) + 'abcd' + // prevout hash (NOT all zeros, 64 hex chars)
      'ffffffff' + // prevout index
      '04' + // scriptsig length
      'deadbeef' + // scriptsig
      'ffffffff' + // sequence
      '01' + // 1 output
      '0000000000000000' + // value
      '00' + // scriptpubkey length
      '00000000'; // locktime

    mockBlockchainTransaction_get.mockResolvedValue(nonCoinbaseHex);

    const result = await mod.isCoinbaseTx(VALID_TXID);
    expect(result).toBe(false);
  });

  it('23b. isCoinbaseTx validates txid format before fetching', async () => {
    const mod = await getConnectedModule();

    await expect(mod.isCoinbaseTx('')).rejects.toThrow('Invalid txid');
    await expect(mod.isCoinbaseTx('tooshort')).rejects.toThrow('Invalid txid');
    await expect(mod.isCoinbaseTx('g'.repeat(64))).rejects.toThrow('Invalid txid');
  });

  it('23c. isCoinbaseTx rejects invalid raw data from server', async () => {
    const mod = await getConnectedModule();

    // Non-hex response
    mockBlockchainTransaction_get.mockResolvedValue('this is not hex data!!!');
    await expect(mod.isCoinbaseTx(VALID_TXID)).rejects.toThrow('Invalid raw transaction data');

    // Non-string response
    mockBlockchainTransaction_get.mockResolvedValue(12345);
    await expect(mod.isCoinbaseTx(VALID_TXID)).rejects.toThrow('Invalid raw transaction data');

    // null response
    mockBlockchainTransaction_get.mockResolvedValue(null);
    await expect(mod.isCoinbaseTx(VALID_TXID)).rejects.toThrow('Invalid raw transaction data');
  });
});

// =====================================================================
// Header Validation
// =====================================================================
describe('VoidElectrum Security - Header Validation', () => {
  it('24. connectMain only accepts integer height >= 0 from header subscription', async () => {
    // Test with a valid integer height
    mockInitElectrum.mockReset().mockResolvedValue(undefined);
    mockBlockchainHeaders_subscribe.mockReset().mockResolvedValue({ height: 12345 });

    let mod: any;
    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(() => {
        try {
          mod = require('../../blue_modules/VoidElectrum');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    // Trigger connection by calling a function that needs it
    mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
    await mod.getBalanceByScripthash(VALID_SCRIPTHASH);

    const block = mod.getLatestBlock();
    expect(block.height).toBe(12345);
    expect(typeof block.time).toBe('number');
    expect(block.time).toBeGreaterThan(0);
  });

  it('24b. connectMain rejects negative height from header subscription', async () => {
    mockInitElectrum.mockReset().mockResolvedValue(undefined);
    mockBlockchainHeaders_subscribe.mockReset().mockResolvedValue({ height: -1 });

    let mod: any;
    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(() => {
        try {
          mod = require('../../blue_modules/VoidElectrum');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
    await mod.getBalanceByScripthash(VALID_SCRIPTHASH);

    const block = mod.getLatestBlock();
    // Negative height should NOT be stored -- height stays undefined
    expect(block.height).toBeUndefined();
  });

  it('24c. connectMain rejects non-integer height from header subscription', async () => {
    mockInitElectrum.mockReset().mockResolvedValue(undefined);
    mockBlockchainHeaders_subscribe.mockReset().mockResolvedValue({ height: 3.14 });

    let mod: any;
    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(() => {
        try {
          mod = require('../../blue_modules/VoidElectrum');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
    await mod.getBalanceByScripthash(VALID_SCRIPTHASH);

    const block = mod.getLatestBlock();
    expect(block.height).toBeUndefined();
  });

  it('24d. connectMain rejects string height from header subscription', async () => {
    mockInitElectrum.mockReset().mockResolvedValue(undefined);
    mockBlockchainHeaders_subscribe.mockReset().mockResolvedValue({ height: '1000' });

    let mod: any;
    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(() => {
        try {
          mod = require('../../blue_modules/VoidElectrum');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
    await mod.getBalanceByScripthash(VALID_SCRIPTHASH);

    const block = mod.getLatestBlock();
    expect(block.height).toBeUndefined();
  });

  it('24e. connectMain handles null header response gracefully', async () => {
    mockInitElectrum.mockReset().mockResolvedValue(undefined);
    mockBlockchainHeaders_subscribe.mockReset().mockResolvedValue(null);

    let mod: any;
    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(() => {
        try {
          mod = require('../../blue_modules/VoidElectrum');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
    await mod.getBalanceByScripthash(VALID_SCRIPTHASH);

    const block = mod.getLatestBlock();
    // null header should not crash; height stays undefined
    expect(block.height).toBeUndefined();
  });

  it('24f. connectMain accepts height = 0 (genesis block)', async () => {
    mockInitElectrum.mockReset().mockResolvedValue(undefined);
    mockBlockchainHeaders_subscribe.mockReset().mockResolvedValue({ height: 0 });

    let mod: any;
    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(() => {
        try {
          mod = require('../../blue_modules/VoidElectrum');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    mockBlockchainScripthash_getBalance.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
    await mod.getBalanceByScripthash(VALID_SCRIPTHASH);

    const block = mod.getLatestBlock();
    expect(block.height).toBe(0);
  });
});

// =====================================================================
// Additional Security Edge Cases
// =====================================================================
describe('VoidElectrum Security - Additional Edge Cases', () => {
  it('broadcastTransaction validates server response is a valid txid', async () => {
    const mod = await getConnectedModule();
    const validHex = 'a'.repeat(100); // 50 bytes, valid hex

    // Server returns garbage instead of txid
    mockBlockchainTransaction_broadcast.mockResolvedValue('error: bad-txns-inputs-missingorspent');
    await expect(mod.broadcastTransaction(validHex)).rejects.toThrow('Broadcast failed');

    // Server returns empty string
    mockBlockchainTransaction_broadcast.mockResolvedValue('');
    await expect(mod.broadcastTransaction(validHex)).rejects.toThrow('Broadcast failed');

    // Server returns null
    mockBlockchainTransaction_broadcast.mockResolvedValue(null);
    await expect(mod.broadcastTransaction(validHex)).rejects.toThrow('Broadcast failed');

    // Server returns valid txid -- should succeed
    mockBlockchainTransaction_broadcast.mockResolvedValue(VALID_TXID);
    const result = await mod.broadcastTransaction(validHex);
    expect(result).toBe(VALID_TXID);
  });

  it('getTransaction validates txid format', async () => {
    const mod = await getConnectedModule();

    await expect(mod.getTransaction('')).rejects.toThrow('Invalid txid');
    await expect(mod.getTransaction('short')).rejects.toThrow('Invalid txid');
    await expect(mod.getTransaction('g'.repeat(64))).rejects.toThrow('Invalid txid');
    await expect(mod.getTransaction(null as any)).rejects.toThrow('Invalid txid');
  });

  it('getRawTransaction validates txid format', async () => {
    const mod = await getConnectedModule();

    await expect(mod.getRawTransaction('')).rejects.toThrow('Invalid txid');
    await expect(mod.getRawTransaction('x'.repeat(64))).rejects.toThrow('Invalid txid');
  });

  it('getTransactionsByScripthash validates scripthash and caps result at 500', async () => {
    const mod = await getConnectedModule();

    // Invalid scripthash
    await expect(mod.getTransactionsByScripthash('bad')).rejects.toThrow('Invalid scripthash');

    // Mock: return 600 items, expect capped at 500
    const bigHistory = Array.from({ length: 600 }, (_, i) => ({ tx_hash: `tx_${i}`, height: i }));
    // We need to mock blockchainScripthash_getHistory -- add it to the mock client
    const mockClient = createMockClient();
    (mockClient as any).blockchainScripthash_getHistory = jest.fn().mockResolvedValue(bigHistory);
    const ElectrumClient = require('electrum-client');
    ElectrumClient.mockImplementation(() => mockClient);

    // Re-import to use new mock
    let mod2: any;
    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(() => {
        try {
          mockInitElectrum.mockReset().mockResolvedValue(undefined);
          mockBlockchainHeaders_subscribe.mockReset().mockResolvedValue({ height: 1000 });
          mod2 = require('../../blue_modules/VoidElectrum');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    const txs = await mod2.getTransactionsByScripthash(VALID_SCRIPTHASH);
    expect(txs.length).toBeLessThanOrEqual(500);
  });

  it('UTXO value of exactly 0 is filtered out (must be > 0)', async () => {
    const mod = await getConnectedModule();
    mockBlockchainScripthash_listunspent.mockResolvedValue([
      { tx_hash: VALID_TXID, value: 0, tx_pos: 0, height: 100 },
    ]);
    const result = await mod.getUtxosByScripthash(VALID_SCRIPTHASH);
    expect(result).toHaveLength(0);
  });

  it('UTXO with non-number value is filtered out', async () => {
    const mod = await getConnectedModule();
    mockBlockchainScripthash_listunspent.mockResolvedValue([
      { tx_hash: VALID_TXID, value: '50000', tx_pos: 0, height: 100 },
      { tx_hash: VALID_TXID, value: null, tx_pos: 1, height: 100 },
      { tx_hash: VALID_TXID, value: undefined, tx_pos: 2, height: 100 },
      { tx_hash: VALID_TXID, value: true, tx_pos: 3, height: 100 },
    ]);
    const result = await mod.getUtxosByScripthash(VALID_SCRIPTHASH);
    expect(result).toHaveLength(0);
  });

  it('UTXO with missing tx_hash field is filtered out', async () => {
    const mod = await getConnectedModule();
    mockBlockchainScripthash_listunspent.mockResolvedValue([
      { value: 50000, tx_pos: 0, height: 100 }, // no tx_hash at all
      { tx_hash: undefined, value: 50000, tx_pos: 1, height: 100 },
      { tx_hash: null, value: 50000, tx_pos: 2, height: 100 },
    ]);
    const result = await mod.getUtxosByScripthash(VALID_SCRIPTHASH);
    expect(result).toHaveLength(0);
  });

  it('getBalanceByScripthash rejects balance exceeding 21M supply', async () => {
    const mod = await getConnectedModule();
    const MAX = 21_000_000 * 100_000_000;

    mockBlockchainScripthash_getBalance.mockResolvedValue({
      confirmed: MAX + 1,
      unconfirmed: 0,
    });

    await expect(mod.getBalanceByScripthash(VALID_SCRIPTHASH)).rejects.toThrow(
      'Balance exceeds maximum supply',
    );
  });

  it('getBalanceByScripthash sanitizes non-numeric balance to 0', async () => {
    const mod = await getConnectedModule();

    mockBlockchainScripthash_getBalance.mockResolvedValue({
      confirmed: 'not-a-number',
      unconfirmed: undefined,
    });

    const balance = await mod.getBalanceByScripthash(VALID_SCRIPTHASH);
    expect(balance.confirmed).toBe(0);
    expect(balance.unconfirmed).toBe(0);
  });
});
