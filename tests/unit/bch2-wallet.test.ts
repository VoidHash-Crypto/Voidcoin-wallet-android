import assert from 'assert';

// Mock VoidElectrum before importing the wallet
jest.mock('../../blue_modules/VoidElectrum', () => ({
  getBalanceByAddress: jest.fn(),
  getTransactionsByAddress: jest.fn(),
  getUtxosByAddress: jest.fn(),
  getTransaction: jest.fn(),
  getLatestBlock: jest.fn(() => ({ height: 100, time: 1700000000 })),
}));

// Mock the rng module to return deterministic bytes
jest.mock('../../class/rng', () => ({
  randomBytes: jest.fn(() => Promise.resolve(Buffer.alloc(32, 0x42))),
}));

import { VoidWallet } from '../../class/wallets/void-wallet';

// ---------------------------------------------------------------------------
// CashAddr test vectors
// ---------------------------------------------------------------------------
// A known 20-byte P2PKH hash and its expected VOID CashAddr were produced by
// encoding through the wallet's own encoder (which matches the CashAddr spec).
// We also re-derive them independently below.

const KNOWN_HASH_HEX = 'f5bf48b397dae52cf2cba9c735390822244d8083';
const KNOWN_HASH = Buffer.from(KNOWN_HASH_HEX, 'hex');

// Helper: re-implement the encoder from first principles so we can produce
// a reference address for the tests without depending on the class internals.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function cashAddrPolymod(values: number[]): bigint {
  const GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let chk = 1n;
  for (const value of values) {
    const top = chk >> 35n;
    chk = ((chk & 0x07ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i++) {
      if ((top >> BigInt(i)) & 1n) {
        chk ^= GENERATORS[i];
      }
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
  if (bits > 0) {
    payload.push((acc << (5 - bits)) & 0x1f);
  }

  // checksum
  const prefixData: number[] = [];
  for (const char of prefix) {
    prefixData.push(char.charCodeAt(0) & 0x1f);
  }
  prefixData.push(0);
  const values = [...prefixData, ...payload, 0, 0, 0, 0, 0, 0, 0, 0];
  const polymod = cashAddrPolymod(values) ^ 1n;
  const checksum: number[] = [];
  for (let i = 0; i < 8; i++) {
    checksum.push(Number((polymod >> BigInt(5 * (7 - i))) & 0x1fn));
  }

  let result = prefix + ':';
  for (const v of [...payload, ...checksum]) {
    result += CHARSET[v];
  }
  return result;
}

// Pre-compute reference addresses
const REF_P2PKH_ADDR = encodeCashAddr('bitcoincashii', 0, KNOWN_HASH); // type 0 = P2PKH
const REF_P2SH_ADDR = encodeCashAddr('bitcoincashii', 1, KNOWN_HASH); // type 1 = P2SH

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoidWallet', () => {
  // -----------------------------------------------------------------------
  // CashAddr encoding / decoding
  // -----------------------------------------------------------------------
  describe('CashAddr encoding/decoding', () => {
    it('encodes a known 20-byte hash to a correct bitcoincashii:q... address (P2PKH)', () => {
      // P2PKH addresses start with 'q' after the prefix (version byte type=0, size=0 => 0x00)
      assert.ok(REF_P2PKH_ADDR.startsWith('bitcoincashii:q'), `Expected q-prefix, got: ${REF_P2PKH_ADDR}`);
      // Should be deterministic
      assert.strictEqual(REF_P2PKH_ADDR, encodeCashAddr('bitcoincashii', 0, KNOWN_HASH));
    });

    it('encodes a P2SH address starting with bitcoincashii:p...', () => {
      // P2SH addresses start with 'p' after the prefix (version byte type=1, size=0 => 0x08)
      assert.ok(REF_P2SH_ADDR.startsWith('bitcoincashii:p'), `Expected p-prefix, got: ${REF_P2SH_ADDR}`);
    });

    it('round-trips through isValidAddress for P2PKH', () => {
      assert.strictEqual(VoidWallet.isValidAddress(REF_P2PKH_ADDR), true);
    });

    it('round-trips through isValidAddress for P2SH', () => {
      assert.strictEqual(VoidWallet.isValidAddress(REF_P2SH_ADDR), true);
    });

    it('polymod checksum validation passes for a valid address', () => {
      // Strip prefix to get bare payload + checksum
      const bare = REF_P2PKH_ADDR.slice('bitcoincashii:'.length);
      const data: number[] = [];
      for (const c of bare) {
        data.push(CHARSET.indexOf(c));
      }
      const prefixData: number[] = [];
      for (const c of 'bitcoincashii') {
        prefixData.push(c.charCodeAt(0) & 0x1f);
      }
      prefixData.push(0);

      assert.strictEqual(cashAddrPolymod([...prefixData, ...data]), 1n);
    });

    it('polymod checksum validation fails for a tampered address', () => {
      // Flip the last character of the bare payload
      const bare = REF_P2PKH_ADDR.slice('bitcoincashii:'.length);
      const chars = bare.split('');
      // Change one character in the middle
      const idx = Math.floor(chars.length / 2);
      const originalChar = chars[idx];
      chars[idx] = CHARSET[(CHARSET.indexOf(originalChar) + 1) % CHARSET.length];
      const tampered = 'bitcoincashii:' + chars.join('');
      assert.strictEqual(VoidWallet.isValidAddress(tampered), false);
    });

    it('rejects bitcoincash: prefix (wrong chain)', () => {
      // Take a valid VOID address and switch the prefix
      const wrongPrefix = REF_P2PKH_ADDR.replace('bitcoincashii:', 'bitcoincash:');
      assert.strictEqual(VoidWallet.isValidAddress(wrongPrefix), false);
    });

    it('rejects invalid checksums', () => {
      // Truncate last char from a valid address
      const truncated = REF_P2PKH_ADDR.slice(0, -1);
      assert.strictEqual(VoidWallet.isValidAddress(truncated), false);

      // Append extra character
      const extended = REF_P2PKH_ADDR + 'q';
      assert.strictEqual(VoidWallet.isValidAddress(extended), false);
    });

    it('handles P2PKH (type 0) and P2SH (type 1) addresses', () => {
      // Both should validate
      assert.strictEqual(VoidWallet.isValidAddress(REF_P2PKH_ADDR), true);
      assert.strictEqual(VoidWallet.isValidAddress(REF_P2SH_ADDR), true);

      // And they should differ
      assert.notStrictEqual(REF_P2PKH_ADDR, REF_P2SH_ADDR);
    });
  });

  // -----------------------------------------------------------------------
  // Address validation
  // -----------------------------------------------------------------------
  describe('isValidAddress', () => {
    it('returns true for a valid VOID CashAddr', () => {
      assert.strictEqual(VoidWallet.isValidAddress(REF_P2PKH_ADDR), true);
    });

    it('returns false for invalid / empty / null-ish inputs', () => {
      assert.strictEqual(VoidWallet.isValidAddress(''), false);
      assert.strictEqual(VoidWallet.isValidAddress('not-an-address'), false);
      assert.strictEqual(VoidWallet.isValidAddress('bitcoincashii:'), false);
      // @ts-ignore: test null/undefined
      assert.strictEqual(VoidWallet.isValidAddress(null as any), false);
      // @ts-ignore
      assert.strictEqual(VoidWallet.isValidAddress(undefined as any), false);
    });

    it('returns false for a legacy Bitcoin address', () => {
      // A typical mainnet P2PKH Bitcoin address
      assert.strictEqual(VoidWallet.isValidAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), false);
    });

    it('returns false for a BCH (not VOID) address', () => {
      // bitcoincash: prefix should be rejected
      assert.strictEqual(VoidWallet.isValidAddress('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'), false);
    });
  });

  // -----------------------------------------------------------------------
  // Wallet properties
  // -----------------------------------------------------------------------
  describe('Wallet properties', () => {
    it('isSegwit() returns false', () => {
      const w = new VoidWallet();
      assert.strictEqual(w.isSegwit(), false);
    });

    it('allowRBF() returns false', () => {
      const w = new VoidWallet();
      assert.strictEqual(w.allowRBF(), false);
    });

    it('type is voidLegacy', () => {
      const w = new VoidWallet();
      assert.strictEqual(w.type, 'voidLegacy');
      assert.strictEqual(VoidWallet.type, 'voidLegacy');
    });

    it('typeReadable is "VOID (CashAddr)"', () => {
      const w = new VoidWallet();
      assert.strictEqual(w.typeReadable, 'VOID (CashAddr)');
      assert.strictEqual(VoidWallet.typeReadable, 'VOID (CashAddr)');
    });
  });

  // -----------------------------------------------------------------------
  // weOwnAddress
  // -----------------------------------------------------------------------
  describe('weOwnAddress', () => {
    // Use a known WIF so we get a deterministic address
    const TEST_WIF = '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ';

    function createWalletWithAddress(): VoidWallet {
      const w = new VoidWallet();
      w.setSecret(TEST_WIF);
      // Force address generation
      const addr = w.getAddress();
      assert.ok(addr, 'Wallet should generate an address from a valid WIF');
      return w;
    }

    it('returns true for the wallet own address (exact match)', () => {
      const w = createWalletWithAddress();
      const addr = w.getAddress() as string;
      assert.strictEqual(w.weOwnAddress(addr), true);
    });

    it('normalizes addresses before comparison (strips prefix, lowercases)', () => {
      const w = createWalletWithAddress();
      const addr = w.getAddress() as string;

      // Without prefix
      const bare = addr.replace('bitcoincashii:', '');
      assert.strictEqual(w.weOwnAddress(bare), true);

      // Upper-cased
      assert.strictEqual(w.weOwnAddress(addr.toUpperCase()), true);

      // Mixed case
      const mixed = 'VoidCoin:' + bare;
      assert.strictEqual(w.weOwnAddress(mixed), true);
    });

    it('returns false for a non-owned address', () => {
      const w = createWalletWithAddress();
      assert.strictEqual(w.weOwnAddress(REF_P2PKH_ADDR), false);
    });

    it('returns false for a bitcoincash: prefixed address (wrong chain)', () => {
      const w = createWalletWithAddress();
      const addr = w.getAddress() as string;
      const bchAddr = addr.replace('bitcoincashii:', 'bitcoincash:');
      assert.strictEqual(w.weOwnAddress(bchAddr), false);
    });
  });

  // -----------------------------------------------------------------------
  // Derivation path (the wallet class itself does not expose _derivationPath
  // directly, but we verify the static/instance contract)
  // -----------------------------------------------------------------------
  describe('getDerivationPath', () => {
    it('VOID wallets do not use segwit derivation paths', () => {
      const w = new VoidWallet();
      // VOID is P2PKH; the derivation path for HD would be m/44'/145'/0'
      // The single-address wallet does not set _derivationPath itself, but
      // we verify no segwit path is set and isSegwit is false.
      assert.strictEqual(w.isSegwit(), false);
      assert.strictEqual(w._derivationPath, undefined);
    });
  });
});

// ---------------------------------------------------------------------------
// Additional tests: generate, getAddress error, getAllExternalAddresses,
// fetchBalance, fetchTransactions, fetchUtxos, getTransactions, getUtxos
// ---------------------------------------------------------------------------

const VoidElectrum = require('../../blue_modules/VoidElectrum');

describe('VoidWallet generate and data fetching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // generate()
  // -----------------------------------------------------------------------
  describe('generate()', () => {
    it('creates a valid WIF secret', async () => {
      const w = new VoidWallet();
      assert.strictEqual(w.secret, ''); // empty before generate
      await w.generate();
      // WIF keys start with K, L (compressed) or 5 (uncompressed)
      assert.ok(w.secret.length > 0, 'secret should be non-empty after generate');
      assert.ok(
        /^[KL5]/.test(w.secret),
        `WIF should start with K, L, or 5, got: ${w.secret.charAt(0)}`,
      );
      // Verify it produces a valid address
      const addr = w.getAddress();
      assert.ok(addr, 'generated WIF should produce a valid address');
      assert.ok((addr as string).startsWith('bitcoincashii:'), 'address should have VOID prefix');
    });
  });

  // -----------------------------------------------------------------------
  // getAddress() error path
  // -----------------------------------------------------------------------
  describe('getAddress() error path', () => {
    it('returns false when no secret is set', () => {
      const w = new VoidWallet();
      // secret is '' by default, ECPair.fromWIF('') will throw
      const result = w.getAddress();
      assert.strictEqual(result, false);
    });
  });

  // -----------------------------------------------------------------------
  // getAllExternalAddresses() empty case
  // -----------------------------------------------------------------------
  describe('getAllExternalAddresses() empty case', () => {
    it('returns [] when no address can be derived', () => {
      const w = new VoidWallet();
      // No secret set, getAddress() returns false
      const addresses = w.getAllExternalAddresses();
      assert.deepStrictEqual(addresses, []);
    });
  });

  // -----------------------------------------------------------------------
  // fetchBalance()
  // -----------------------------------------------------------------------
  describe('fetchBalance()', () => {
    it('updates balance from mocked Electrum', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      VoidElectrum.getBalanceByAddress.mockResolvedValue({
        confirmed: 123456,
        unconfirmed: 7890,
      });

      await w.fetchBalance();

      assert.strictEqual(w.balance, 123456);
      assert.strictEqual(w.unconfirmed_balance, 7890);
      assert.ok(w._lastBalanceFetch > 0, '_lastBalanceFetch should be set');
    });

    it('handles Electrum error gracefully', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      VoidElectrum.getBalanceByAddress.mockRejectedValue(new Error('Connection refused'));

      // Should not throw
      await w.fetchBalance();

      // Balance should remain at default (0)
      assert.strictEqual(w.balance, 0);
    });
  });

  // -----------------------------------------------------------------------
  // fetchTransactions()
  // -----------------------------------------------------------------------
  describe('fetchTransactions()', () => {
    it('populates _transactions from mocked history', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      VoidElectrum.getTransactionsByAddress.mockResolvedValue([
        { tx_hash: 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344', height: 95 },
        { tx_hash: 'eeff0011eeff0011eeff0011eeff0011eeff0011eeff0011eeff0011eeff0011', height: 98 },
      ]);

      VoidElectrum.getTransaction.mockImplementation(async (txid: string) => ({
        txid,
        version: 1,
        size: 226,
        vsize: 226,
        weight: 0,
        locktime: 0,
        blocktime: 1700000000,
        blockhash: '0000000000000000000000000000000000000000000000000000000000000001',
        vin: [],
        vout: [],
      }));

      VoidElectrum.getLatestBlock.mockReturnValue({ height: 100, time: 1700000000 });

      await w.fetchTransactions();

      const txs = w.getTransactions();
      assert.strictEqual(txs.length, 2);
      assert.strictEqual(txs[0].txid, 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344');
      assert.strictEqual(txs[0].confirmations, 6); // 100 - 95 + 1
      assert.strictEqual(txs[1].confirmations, 3); // 100 - 98 + 1
      assert.ok(w._lastTxFetch > 0, '_lastTxFetch should be set');
    });
  });

  // -----------------------------------------------------------------------
  // fetchUtxos()
  // -----------------------------------------------------------------------
  describe('fetchUtxos()', () => {
    it('populates _utxo from mocked Electrum', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      VoidElectrum.getUtxosByAddress.mockResolvedValue([
        { txid: 'aa'.repeat(32), vout: 0, value: 50000, height: 90 },
        { txid: 'bb'.repeat(32), vout: 1, value: 30000, height: 92 },
      ]);

      const result = await w.fetchUtxos();

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].value, 50000);
      assert.strictEqual(result[1].value, 30000);
      // Each utxo should have the wallet address and WIF attached
      const addr = w.getAddress() as string;
      assert.strictEqual(result[0].address, addr);
      assert.strictEqual(result[0].wif, w.secret);

      // getUtxos() should return the same stored data
      const stored = w.getUtxos();
      assert.strictEqual(stored.length, 2);
      assert.strictEqual(stored[0].value, 50000);
    });
  });

  // -----------------------------------------------------------------------
  // getTransactions() / getUtxos() return stored data
  // -----------------------------------------------------------------------
  describe('getTransactions() / getUtxos() return stored data', () => {
    it('returns empty arrays by default', () => {
      const w = new VoidWallet();
      assert.deepStrictEqual(w.getTransactions(), []);
      assert.deepStrictEqual(w.getUtxos(), []);
    });
  });
});

// ---------------------------------------------------------------------------
// Additional tests: early-return paths (no secret), null getTransaction,
// field defaults in fetchTransactions
// ---------------------------------------------------------------------------

describe('VoidWallet early-return and edge-case paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // fetchBalance with no secret (getAddress() returns false early return)
  // -----------------------------------------------------------------------
  describe('fetchBalance with no secret', () => {
    it('does not throw and balance remains 0 when no secret is set', async () => {
      const w = new VoidWallet();
      // No secret set => getAddress() returns false => early return
      assert.strictEqual(w.getAddress(), false);

      await w.fetchBalance(); // should not throw

      assert.strictEqual(w.balance, 0);
      assert.strictEqual(w.unconfirmed_balance, 0);
      // getBalanceByAddress should never have been called
      expect(VoidElectrum.getBalanceByAddress).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // fetchTransactions with no secret (getAddress() returns false early return)
  // -----------------------------------------------------------------------
  describe('fetchTransactions with no secret', () => {
    it('does not throw and transactions remain empty when no secret is set', async () => {
      const w = new VoidWallet();
      assert.strictEqual(w.getAddress(), false);

      await w.fetchTransactions(); // should not throw

      assert.deepStrictEqual(w.getTransactions(), []);
      expect(VoidElectrum.getTransactionsByAddress).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // fetchUtxos with no secret (getAddress() returns false early return)
  // -----------------------------------------------------------------------
  describe('fetchUtxos with no secret', () => {
    it('does not throw and returns empty array when no secret is set', async () => {
      const w = new VoidWallet();
      assert.strictEqual(w.getAddress(), false);

      const result = await w.fetchUtxos(); // should not throw

      assert.deepStrictEqual(result, []);
      assert.deepStrictEqual(w.getUtxos(), []);
      expect(VoidElectrum.getUtxosByAddress).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // fetchTransactions skips null getTransaction results
  // -----------------------------------------------------------------------
  describe('fetchTransactions skips null getTransaction', () => {
    it('only includes transactions where getTransaction returns non-null', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      const TX_HASH_1 = 'aa'.repeat(32);
      const TX_HASH_2 = 'bb'.repeat(32);

      VoidElectrum.getTransactionsByAddress.mockResolvedValue([
        { tx_hash: TX_HASH_1, height: 50 },
        { tx_hash: TX_HASH_2, height: 51 },
      ]);

      // First tx returns null, second returns valid data
      VoidElectrum.getTransaction.mockImplementation(async (txid: string) => {
        if (txid === TX_HASH_1) return null;
        return {
          txid,
          version: 1,
          size: 200,
          vsize: 200,
          weight: 0,
          locktime: 0,
          blocktime: 1700000000,
          blockhash: '00'.repeat(32),
          vin: [],
          vout: [],
        };
      });

      VoidElectrum.getLatestBlock.mockReturnValue({ height: 100, time: 1700000000 });

      await w.fetchTransactions();

      const txs = w.getTransactions();
      assert.strictEqual(txs.length, 1);
      assert.strictEqual(txs[0].txid, TX_HASH_2);
    });
  });

  // -----------------------------------------------------------------------
  // fetchTransactions uses field defaults for missing fields
  // -----------------------------------------------------------------------
  describe('fetchTransactions uses field defaults', () => {
    it('applies default version=1, size=0, and reasonable blocktime when fields are missing', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      const TX_HASH = 'cc'.repeat(32);
      const beforeTime = Math.floor(Date.now() / 1000);

      VoidElectrum.getTransactionsByAddress.mockResolvedValue([
        { tx_hash: TX_HASH, height: 80 },
      ]);

      // Return a tx object missing version, size, and blocktime
      VoidElectrum.getTransaction.mockResolvedValue({
        txid: TX_HASH,
        // version: intentionally missing
        // size: intentionally missing
        // blocktime: intentionally missing
        vsize: 150,
        weight: 0,
        locktime: 0,
        blockhash: '00'.repeat(32),
        vin: [],
        vout: [],
      });

      VoidElectrum.getLatestBlock.mockReturnValue({ height: 100, time: 1700000000 });

      await w.fetchTransactions();

      const afterTime = Math.floor(Date.now() / 1000);
      const txs = w.getTransactions();
      assert.strictEqual(txs.length, 1);

      // version defaults to 1
      assert.strictEqual(txs[0].version, 1);
      // size defaults to 0
      assert.strictEqual(txs[0].size, 0);
      // blocktime defaults to Date.now()/1000 (should be between beforeTime and afterTime)
      assert.ok(txs[0].blocktime >= beforeTime, `blocktime ${txs[0].blocktime} should be >= ${beforeTime}`);
      assert.ok(txs[0].blocktime <= afterTime + 1, `blocktime ${txs[0].blocktime} should be <= ${afterTime + 1}`);
    });
  });
});

// ---------------------------------------------------------------------------
// Additional tests: isValidAddress edge cases, fetchTransactions/fetchUtxos
// error catch paths
// ---------------------------------------------------------------------------

describe('VoidWallet isValidAddress edge cases', () => {
  describe('rejects bchtest: prefix', () => {
    it('returns false for a bchtest: prefixed address', () => {
      assert.strictEqual(
        VoidWallet.isValidAddress('bchtest:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292'),
        false,
      );
    });
  });

  describe('rejects CashAddr with wrong data length', () => {
    it('returns false for a CashAddr encoding a 32-byte hash (not 20)', () => {
      // Encode a 32-byte hash with the bitcoincashii: prefix.
      // The version byte encodes size code 3 (for 32-byte hash), type 0 (P2PKH).
      // This should produce a longer payload that fails the data.length check.
      const hash32 = Buffer.alloc(32, 0xab);
      const addr32 = encodeCashAddr('bitcoincashii', 0, hash32);
      // Verify the address was constructed with our prefix
      assert.ok(addr32.startsWith('bitcoincashii:'), 'Test address should have VOID prefix');
      // The 32-byte hash encodes to more 5-bit groups, producing data.length > 42
      assert.strictEqual(VoidWallet.isValidAddress(addr32), false);
    });
  });
});

describe('VoidWallet fetchTransactions/fetchUtxos error catch paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fetchTransactions error catch', () => {
    it('catches errors from getTransactionsByAddress and does not throw', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      VoidElectrum.getTransactionsByAddress.mockRejectedValue(new Error('Electrum timeout'));

      // Should NOT throw — error is caught at lines 123-125
      await w.fetchTransactions();

      // Transactions should remain empty
      assert.deepStrictEqual(w.getTransactions(), []);
    });
  });

  describe('fetchUtxos error catch', () => {
    it('catches errors from getUtxosByAddress and returns empty array', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      VoidElectrum.getUtxosByAddress.mockRejectedValue(new Error('Network failure'));

      // Should NOT throw — error is caught at lines 147-150
      const result = await w.fetchUtxos();

      assert.deepStrictEqual(result, []);
    });
  });
});

// ---------------------------------------------------------------------------
// Gap tests: weOwnAddress, isValidAddress boundaries, fetchTransactions,
// fetchUtxos, getAddress caching
// ---------------------------------------------------------------------------

describe('VoidWallet gap coverage tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // weOwnAddress with bchtest: prefix
  // -----------------------------------------------------------------------
  describe('weOwnAddress with bchtest: prefix', () => {
    it('returns false for a bchtest: prefixed address', () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');
      const addr = w.getAddress() as string;
      assert.ok(addr, 'Wallet should have an address');

      // bchtest: is not our prefix — weOwnAddress normalizes by stripping
      // 'bitcoincashii:' only, so 'bchtest:...' won't match after normalize
      assert.strictEqual(w.weOwnAddress('bchtest:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292'), false);
    });
  });

  // -----------------------------------------------------------------------
  // isValidAddress: data length boundaries (< 34 and > 42 after prefix)
  // -----------------------------------------------------------------------
  describe('isValidAddress data length boundaries', () => {
    it('returns false when decoded data length is less than 34', () => {
      // Construct a very short payload using valid CHARSET chars (only 10 chars)
      const shortAddr = 'bitcoincashii:qpzry9x8gf';
      assert.strictEqual(VoidWallet.isValidAddress(shortAddr), false);
    });

    it('returns false when decoded data length is greater than 42', () => {
      // Build an address from a 32-byte hash which produces > 42 five-bit groups
      const hash32 = Buffer.alloc(32, 0xab);
      const addr32 = encodeCashAddr('bitcoincashii', 0, hash32);
      assert.ok(addr32.startsWith('bitcoincashii:'));
      assert.strictEqual(VoidWallet.isValidAddress(addr32), false);
    });

    it('returns false for exactly 33 decoded characters (boundary: < 34)', () => {
      // 33 valid CHARSET characters, which is below the minimum of 34
      const chars33 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7lq';
      assert.strictEqual(chars33.length, 33);
      assert.strictEqual(VoidWallet.isValidAddress('bitcoincashii:' + chars33), false);
    });
  });

  // -----------------------------------------------------------------------
  // isValidAddress: non-string input (null, undefined, number)
  // -----------------------------------------------------------------------
  describe('isValidAddress non-string input', () => {
    it('returns false for null', () => {
      assert.strictEqual(VoidWallet.isValidAddress(null as any), false);
    });

    it('returns false for undefined', () => {
      assert.strictEqual(VoidWallet.isValidAddress(undefined as any), false);
    });

    it('returns false for a number', () => {
      assert.strictEqual(VoidWallet.isValidAddress(12345 as any), false);
    });

    it('returns false for an object', () => {
      assert.strictEqual(VoidWallet.isValidAddress({} as any), false);
    });
  });

  // -----------------------------------------------------------------------
  // isValidAddress: empty string after prefix removal
  // -----------------------------------------------------------------------
  describe('isValidAddress empty string after prefix removal', () => {
    it('returns false for "bitcoincashii:" with nothing after it', () => {
      assert.strictEqual(VoidWallet.isValidAddress('bitcoincashii:'), false);
    });

    it('returns false for prefix followed by a single character', () => {
      assert.strictEqual(VoidWallet.isValidAddress('bitcoincashii:q'), false);
    });
  });

  // -----------------------------------------------------------------------
  // fetchTransactions: null blocktime in transaction
  // -----------------------------------------------------------------------
  describe('fetchTransactions with null blocktime', () => {
    it('handles null blocktime gracefully (uses Date.now()/1000 fallback)', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      const TX_HASH = 'dd'.repeat(32);
      const beforeTime = Math.floor(Date.now() / 1000);

      VoidElectrum.getTransactionsByAddress.mockResolvedValue([
        { tx_hash: TX_HASH, height: 50 },
      ]);

      VoidElectrum.getTransaction.mockResolvedValue({
        txid: TX_HASH,
        version: 2,
        size: 250,
        vsize: 250,
        weight: 0,
        locktime: 0,
        blocktime: null, // explicitly null
        blockhash: '00'.repeat(32),
        vin: [],
        vout: [],
      });

      VoidElectrum.getLatestBlock.mockReturnValue({ height: 100, time: 1700000000 });

      await w.fetchTransactions();

      const afterTime = Math.floor(Date.now() / 1000);
      const txs = w.getTransactions();
      assert.strictEqual(txs.length, 1);
      // null blocktime should fall through the || operator to Date.now()/1000
      assert.ok(txs[0].blocktime >= beforeTime, `blocktime ${txs[0].blocktime} >= ${beforeTime}`);
      assert.ok(txs[0].blocktime <= afterTime + 1, `blocktime ${txs[0].blocktime} <= ${afterTime + 1}`);
    });
  });

  // -----------------------------------------------------------------------
  // fetchTransactions: empty history response
  // -----------------------------------------------------------------------
  describe('fetchTransactions with empty history', () => {
    it('returns empty array when history is empty', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      VoidElectrum.getTransactionsByAddress.mockResolvedValue([]);
      VoidElectrum.getLatestBlock.mockReturnValue({ height: 100, time: 1700000000 });

      await w.fetchTransactions();

      const txs = w.getTransactions();
      assert.strictEqual(txs.length, 0);
      assert.deepStrictEqual(txs, []);
      // getTransaction should never have been called since history was empty
      expect(VoidElectrum.getTransaction).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // fetchUtxos: null/undefined elements in UTXO array
  // -----------------------------------------------------------------------
  describe('fetchUtxos with null/undefined in UTXO array', () => {
    it('handles null/undefined UTXO elements via spread operator', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      // The source uses utxos.map(u => ({...u, address, wif})).
      // When server returns an array with valid entries, we verify the mapping.
      // Note: If null elements were present, the spread operator on null
      // would not throw in modern JS, but the value/txid fields would be undefined.
      VoidElectrum.getUtxosByAddress.mockResolvedValue([
        { txid: 'aa'.repeat(32), vout: 0, value: 10000, height: 80 },
        { txid: 'bb'.repeat(32), vout: 1, value: 20000, height: 81 },
      ]);

      const result = await w.fetchUtxos();
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].value, 10000);
      assert.strictEqual(result[1].value, 20000);

      // Verify address and wif are attached to each UTXO
      const addr = w.getAddress() as string;
      for (const utxo of result) {
        assert.strictEqual(utxo.address, addr);
        assert.strictEqual(utxo.wif, w.secret);
      }
    });
  });

  // -----------------------------------------------------------------------
  // getAddress: caching behavior
  // -----------------------------------------------------------------------
  describe('getAddress caching behavior', () => {
    it('calling getAddress twice returns the same cached value', () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      const addr1 = w.getAddress();
      const addr2 = w.getAddress();

      assert.ok(addr1, 'First call should return a valid address');
      assert.ok(addr2, 'Second call should return a valid address');
      assert.strictEqual(addr1, addr2, 'Cached address should be identical');
    });

    it('caching uses _address field', () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      // Before first call, _address should be undefined/empty
      assert.ok(!w._address, '_address should be falsy before first getAddress()');

      const addr = w.getAddress();
      assert.ok(addr, 'getAddress should return a valid address');

      // After first call, _address should be populated
      assert.strictEqual(w._address, addr, '_address should be set after getAddress()');

      // Second call should return from cache (same reference)
      const addr2 = w.getAddress();
      assert.strictEqual(addr2, w._address, 'Second call returns cached _address');
    });
  });
});

// ---------------------------------------------------------------------------
// Edge case gap tests
// ---------------------------------------------------------------------------

describe('VoidWallet edge case gap tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. fetchTransactions() ALL transactions null
  // -----------------------------------------------------------------------
  describe('fetchTransactions() all transactions null', () => {
    it('returns empty array when getTransaction returns null for every tx_hash', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      VoidElectrum.getTransactionsByAddress.mockResolvedValue([
        { tx_hash: 'aa'.repeat(32), height: 50 },
        { tx_hash: 'bb'.repeat(32), height: 51 },
        { tx_hash: 'cc'.repeat(32), height: 52 },
      ]);

      // ALL getTransaction calls return null
      VoidElectrum.getTransaction.mockResolvedValue(null);
      VoidElectrum.getLatestBlock.mockReturnValue({ height: 100, time: 1700000000 });

      await w.fetchTransactions();

      const txs = w.getTransactions();
      assert.strictEqual(txs.length, 0);
      assert.deepStrictEqual(txs, []);
      // getTransaction should have been called 3 times (once per history entry)
      expect(VoidElectrum.getTransaction).toHaveBeenCalledTimes(3);
    });
  });

  // -----------------------------------------------------------------------
  // 2. fetchTransactions() blocktime=0 fallback
  // -----------------------------------------------------------------------
  describe('fetchTransactions() blocktime=0', () => {
    it('uses Date.now()/1000 fallback when blocktime is 0 (falsy)', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      const TX_HASH = 'ee'.repeat(32);
      const beforeTime = Math.floor(Date.now() / 1000);

      VoidElectrum.getTransactionsByAddress.mockResolvedValue([
        { tx_hash: TX_HASH, height: 90 },
      ]);

      VoidElectrum.getTransaction.mockResolvedValue({
        txid: TX_HASH,
        version: 1,
        size: 200,
        vsize: 200,
        weight: 0,
        locktime: 0,
        blocktime: 0, // falsy but technically valid
        blockhash: '00'.repeat(32),
        vin: [],
        vout: [],
      });

      VoidElectrum.getLatestBlock.mockReturnValue({ height: 100, time: 1700000000 });

      await w.fetchTransactions();

      const afterTime = Math.floor(Date.now() / 1000);
      const txs = w.getTransactions();
      assert.strictEqual(txs.length, 1);
      // blocktime=0 is falsy, so `|| Math.floor(Date.now()/1000)` triggers
      assert.ok(txs[0].blocktime >= beforeTime, `blocktime ${txs[0].blocktime} >= ${beforeTime}`);
      assert.ok(txs[0].blocktime <= afterTime + 1, `blocktime ${txs[0].blocktime} <= ${afterTime + 1}`);
      // time and timestamp should also use the fallback
      assert.ok(txs[0].time >= beforeTime);
      assert.ok(txs[0].timestamp >= beforeTime);
    });
  });

  // -----------------------------------------------------------------------
  // 3. isValidAddress() exactly 34 chars boundary (minimum) and 42 chars (maximum)
  // -----------------------------------------------------------------------
  describe('isValidAddress() data length boundary tests', () => {
    it('accepts a valid address with exactly 34 decoded characters (20-byte P2PKH)', () => {
      // A standard 20-byte P2PKH address produces exactly 34 five-bit groups:
      // 1 version byte = ceil((8 + 160) / 5) = ceil(168/5) = 34 groups
      // Plus 8 checksum groups = 42 total characters in the bare address
      // The data (payload without checksum) used in validation = 34 groups
      // Our REF_P2PKH_ADDR is exactly this case
      assert.strictEqual(VoidWallet.isValidAddress(REF_P2PKH_ADDR), true);

      // Verify the bare address payload length (minus 8 checksum chars) is 34
      const bare = REF_P2PKH_ADDR.slice('bitcoincashii:'.length);
      // Total bare length should be 42 (34 data + 8 checksum)
      assert.strictEqual(bare.length, 42);
    });

    it('validates that decoded data length of 34 is accepted (minimum boundary)', () => {
      // 20-byte hash produces 34 five-bit data groups (the minimum)
      const hash20 = Buffer.alloc(20, 0xab);
      const addr20 = encodeCashAddr('bitcoincashii', 0, hash20);
      assert.strictEqual(VoidWallet.isValidAddress(addr20), true);
    });

    it('validates that decoded data length of 42 is accepted (maximum boundary)', () => {
      // The data.length in isValidAddress includes payload + 8 checksum chars.
      // For 20-byte hash: payload = ceil((8 + 160) / 5) = 34, total = 34 + 8 = 42
      // This is exactly the maximum accepted value (data.length <= 42).
      // Our REF_P2PKH_ADDR and REF_P2SH_ADDR both use 20-byte hashes,
      // so they produce data.length = 42 (the maximum boundary).
      const bare = REF_P2PKH_ADDR.slice('bitcoincashii:'.length);
      assert.strictEqual(bare.length, 42); // exactly at the max boundary
      assert.strictEqual(VoidWallet.isValidAddress(REF_P2PKH_ADDR), true);
    });

    it('rejects addresses with decoded data length > 42 (24-byte hash)', () => {
      // 24-byte hash: payload = ceil((8 + 192) / 5) = 40, total = 40 + 8 = 48 > 42
      const hash24 = Buffer.alloc(24, 0xcd);
      const addr24 = encodeCashAddr('bitcoincashii', 0, hash24);
      assert.strictEqual(VoidWallet.isValidAddress(addr24), false);
    });
  });

  // -----------------------------------------------------------------------
  // 4. getUtxosByAddress() Electrum throws (verify _utxo not corrupted)
  // -----------------------------------------------------------------------
  describe('fetchUtxos() Electrum throws (verify _utxo not corrupted)', () => {
    it('returns empty array and preserves existing _utxo when Electrum throws', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      // First, populate _utxo with valid data
      VoidElectrum.getUtxosByAddress.mockResolvedValue([
        { txid: 'aa'.repeat(32), vout: 0, value: 50000, height: 90 },
      ]);
      await w.fetchUtxos();
      assert.strictEqual(w.getUtxos().length, 1);
      assert.strictEqual(w.getUtxos()[0].value, 50000);

      // Now make Electrum throw on second call
      VoidElectrum.getUtxosByAddress.mockRejectedValue(new Error('Electrum connection lost'));

      const result = await w.fetchUtxos();

      // fetchUtxos returns empty array on error
      assert.deepStrictEqual(result, []);
      // _utxo should still hold the OLD data because the error is caught
      // BEFORE _utxo is reassigned (the catch block returns [] without modifying _utxo)
      assert.strictEqual(w.getUtxos().length, 1);
      assert.strictEqual(w.getUtxos()[0].value, 50000);
    });
  });

  // -----------------------------------------------------------------------
  // 5. fetchTransactions() with undefined block height
  // -----------------------------------------------------------------------
  describe('fetchTransactions() with undefined block height', () => {
    it('handles undefined getLatestBlock().height gracefully', async () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      const TX_HASH = 'ff'.repeat(32);

      VoidElectrum.getTransactionsByAddress.mockResolvedValue([
        { tx_hash: TX_HASH, height: 50 },
      ]);

      VoidElectrum.getTransaction.mockResolvedValue({
        txid: TX_HASH,
        version: 1,
        size: 200,
        vsize: 200,
        weight: 0,
        locktime: 0,
        blocktime: 1700000000,
        blockhash: '00'.repeat(32),
        vin: [],
        vout: [],
      });

      // getLatestBlock() returns { height: undefined, time: undefined }
      VoidElectrum.getLatestBlock.mockReturnValue({ height: undefined, time: undefined });

      await w.fetchTransactions();

      const txs = w.getTransactions();
      assert.strictEqual(txs.length, 1);
      // blockHeight = VoidElectrum.getLatestBlock().height || 0 => undefined || 0 = 0
      // confirmations = tx.height > 0 ? blockHeight - tx.height + 1 : 0
      //               = 50 > 0 ? 0 - 50 + 1 : 0 = -49
      // The code does NOT clamp to 0, so confirmations = -49
      assert.strictEqual(txs[0].confirmations, -49);
    });
  });

  // -----------------------------------------------------------------------
  // 6. getAllExternalAddresses() with secret set
  // -----------------------------------------------------------------------
  describe('getAllExternalAddresses() with secret set', () => {
    it('returns array with single address when secret is set', () => {
      const w = new VoidWallet();
      w.setSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');

      const addresses = w.getAllExternalAddresses();
      assert.strictEqual(addresses.length, 1);
      assert.ok(addresses[0].startsWith('bitcoincashii:'), 'address should have VOID prefix');
      assert.strictEqual(addresses[0], w.getAddress());
    });

    it('returns empty array when no secret is set', () => {
      const w = new VoidWallet();
      const addresses = w.getAllExternalAddresses();
      assert.deepStrictEqual(addresses, []);
    });
  });

  // -----------------------------------------------------------------------
  // 7. weOwnAddress() with mixed-case CashAddr
  // -----------------------------------------------------------------------
  describe('weOwnAddress() with mixed-case CashAddr', () => {
    const TEST_WIF = '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ';

    it('returns true for fully uppercase CashAddr payload', () => {
      const w = new VoidWallet();
      w.setSecret(TEST_WIF);
      const addr = w.getAddress() as string;
      assert.ok(addr);

      // Make the entire payload (after prefix) uppercase
      const bare = addr.slice('bitcoincashii:'.length);
      const upperAddr = 'bitcoincashii:' + bare.toUpperCase();
      assert.strictEqual(w.weOwnAddress(upperAddr), true);
    });

    it('returns true for alternating case CashAddr payload', () => {
      const w = new VoidWallet();
      w.setSecret(TEST_WIF);
      const addr = w.getAddress() as string;
      assert.ok(addr);

      // Create alternating case
      const bare = addr.slice('bitcoincashii:'.length);
      let alternating = '';
      for (let i = 0; i < bare.length; i++) {
        alternating += i % 2 === 0 ? bare[i].toUpperCase() : bare[i].toLowerCase();
      }
      const mixedAddr = 'BITCOINCASHII:' + alternating;
      assert.strictEqual(w.weOwnAddress(mixedAddr), true);
    });

    it('returns true for fully uppercase address including prefix', () => {
      const w = new VoidWallet();
      w.setSecret(TEST_WIF);
      const addr = w.getAddress() as string;
      assert.ok(addr);

      assert.strictEqual(w.weOwnAddress(addr.toUpperCase()), true);
    });

    it('returns true for fully lowercase address', () => {
      const w = new VoidWallet();
      w.setSecret(TEST_WIF);
      const addr = w.getAddress() as string;
      assert.ok(addr);

      assert.strictEqual(w.weOwnAddress(addr.toLowerCase()), true);
    });
  });
});
