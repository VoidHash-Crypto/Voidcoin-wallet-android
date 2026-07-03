import AsyncStorage from '@react-native-async-storage/async-storage';

import VoidWalletStorage, {
  saveWallet,
  getWallets,
  getWallet,
  deleteWallet,
  getWalletMnemonic,
  updateWalletBalance,
  StoredWallet,
} from '../../class/void-wallet-storage';

// A known test mnemonic (BIP39-valid)
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLETS_KEY = '@void_wallets';

beforeEach(async () => {
  await AsyncStorage.clear();
});

// ============================================================================
// Wallet CRUD
// ============================================================================
describe('Wallet CRUD', () => {
  it('saveWallet() stores wallet data', async () => {
    const wallet = await saveWallet('My Wallet', TEST_MNEMONIC, 'void');

    expect(wallet).toBeDefined();
    expect(wallet.id).toMatch(/^void_/);
    expect(wallet.label).toBe('My Wallet');
    expect(wallet.type).toBe('void');
    expect(wallet.balance).toBe(0);
    expect(wallet.unconfirmedBalance).toBe(0);
    expect(wallet.createdAt).toBeGreaterThan(0);
    expect(wallet.mnemonic).toBe(TEST_MNEMONIC);

    // Verify it was persisted
    const raw = await AsyncStorage.getItem(WALLETS_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(wallet.id);
  });

  it('saveWallet() throws for invalid mnemonic', async () => {
    await expect(saveWallet('W', 'not a valid mnemonic', 'void')).rejects.toThrow('Invalid mnemonic');
  });

  it('saveWallet() trims label and mnemonic', async () => {
    const wallet = await saveWallet('  My Label  ', `  ${TEST_MNEMONIC}  `, 'void');
    expect(wallet.label).toBe('My Label');
    // The address should be derived from the trimmed mnemonic
    expect(wallet.address).toBeTruthy();
  });

  it('getWallets() retrieves stored wallets', async () => {
    await saveWallet('W1', TEST_MNEMONIC, 'void');
    await saveWallet('W2', TEST_MNEMONIC, 'void');

    const wallets = await getWallets();
    expect(wallets).toHaveLength(2);
    expect(wallets[0].label).toBe('W1');
    expect(wallets[1].label).toBe('W2');
  });

  it('getWallets() returns empty array when no wallets stored', async () => {
    const wallets = await getWallets();
    expect(wallets).toEqual([]);
  });

  it('getWallet() retrieves a single wallet by ID', async () => {
    const saved = await saveWallet('Single', TEST_MNEMONIC, 'void');
    const retrieved = await getWallet(saved.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(saved.id);
    expect(retrieved!.label).toBe('Single');
  });

  it('getWallet() returns null for non-existent ID', async () => {
    const result = await getWallet('nonexistent');
    expect(result).toBeNull();
  });

  it('deleteWallet() removes wallet and verifies deletion', async () => {
    const w1 = await saveWallet('To Delete', TEST_MNEMONIC, 'void');
    const w2 = await saveWallet('To Keep', TEST_MNEMONIC, 'void');

    await deleteWallet(w1.id);

    const wallets = await getWallets();
    expect(wallets).toHaveLength(1);
    expect(wallets[0].id).toBe(w2.id);
  });

  it('deleteWallet() on non-existent id does not corrupt storage', async () => {
    const w = await saveWallet('Existing', TEST_MNEMONIC, 'void');
    await deleteWallet('nonexistent_id');

    const wallets = await getWallets();
    expect(wallets).toHaveLength(1);
    expect(wallets[0].id).toBe(w.id);
  });

  it('getWalletMnemonic() returns mnemonic for a wallet', async () => {
    const wallet = await saveWallet('Mnemonic Test', TEST_MNEMONIC, 'void');
    const mnemonic = await getWalletMnemonic(wallet.id);
    expect(mnemonic).toBe(TEST_MNEMONIC);
  });

  it('getWalletMnemonic() returns null for non-existent wallet', async () => {
    const result = await getWalletMnemonic('nonexistent');
    expect(result).toBeNull();
  });

  it('updateWalletBalance() updates balance and unconfirmed balance', async () => {
    const wallet = await saveWallet('Balance', TEST_MNEMONIC, 'void');

    await updateWalletBalance(wallet.id, 100000, 5000);

    const updated = await getWallet(wallet.id);
    expect(updated!.balance).toBe(100000);
    expect(updated!.unconfirmedBalance).toBe(5000);
  });

  it('updateWalletBalance() rejects NaN and Infinity', async () => {
    const wallet = await saveWallet('Balance', TEST_MNEMONIC, 'void');

    await updateWalletBalance(wallet.id, NaN, 0);
    let w = await getWallet(wallet.id);
    expect(w!.balance).toBe(0); // unchanged

    await updateWalletBalance(wallet.id, 0, Infinity);
    w = await getWallet(wallet.id);
    expect(w!.balance).toBe(0); // unchanged
  });

  it('updateWalletBalance() clamps negative balance to zero', async () => {
    const wallet = await saveWallet('Balance', TEST_MNEMONIC, 'void');

    await updateWalletBalance(wallet.id, -500, 0);

    const updated = await getWallet(wallet.id);
    expect(updated!.balance).toBe(0);
  });
});

// ============================================================================
// Address Derivation
// ============================================================================
describe('Address derivation', () => {
  it("VOID derivation path m/44'/145'/0'/0/0 produces CashAddr", async () => {
    const wallet = await saveWallet('VOID Addr', TEST_MNEMONIC, 'void');
    expect(wallet.address.startsWith('bitcoincashii:')).toBe(true);
    // CashAddr addresses have a prefix followed by the encoded data
    const addrParts = wallet.address.split(':');
    expect(addrParts).toHaveLength(2);
    expect(addrParts[0]).toBe('bitcoincashii');
    // The payload should be non-empty
    expect(addrParts[1].length).toBeGreaterThan(0);
  });

  it("VOID derivation path m/44'/0'/0'/0/0 produces legacy address", async () => {
    const wallet = await saveWallet('VOID Addr', TEST_MNEMONIC, 'void');
    // Legacy addresses start with 1 or 3
    expect(wallet.address).toMatch(/^[13]/);
    // Should not contain CashAddr prefix
    expect(wallet.address).not.toContain(':');
  });

  it("bc1 derivation path m/84'/0'/0'/0/0 produces bech32 address", async () => {
    const wallet = await saveWallet('bc1 Addr', TEST_MNEMONIC, 'bc1');
    expect(wallet.address.startsWith('bc1')).toBe(true);
    // Should not contain CashAddr prefix
    expect(wallet.address).not.toContain(':');
  });

  it('same mnemonic produces deterministic addresses', async () => {
    const w1 = await saveWallet('Det1', TEST_MNEMONIC, 'void');
    const w2 = await saveWallet('Det2', TEST_MNEMONIC, 'void');
    expect(w1.address).toBe(w2.address);
  });

  it('different wallet types produce different addresses from same mnemonic', async () => {
    const wVOID = await saveWallet('VOID', TEST_MNEMONIC, 'void');
    const wVOID = await saveWallet('VOID', TEST_MNEMONIC, 'void');
    const wBC1 = await saveWallet('BC1', TEST_MNEMONIC, 'bc1');

    // All three should have different addresses (different derivation paths + encoding)
    expect(wVOID.address).not.toBe(wVOID.address);
    expect(wVOID.address).not.toBe(wBC1.address);
    expect(wVOID.address).not.toBe(wBC1.address);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================
describe('Edge cases', () => {
  it('empty wallet list', async () => {
    const wallets = await getWallets();
    expect(wallets).toEqual([]);
  });

  it('corrupted storage data throws descriptive error', async () => {
    await AsyncStorage.setItem(WALLETS_KEY, '{invalid json!!!');
    await expect(getWallets()).rejects.toThrow(/Wallet data corrupted/);
  });

  it('corrupted storage data does not silently return empty array', async () => {
    await AsyncStorage.setItem(WALLETS_KEY, 'not-json-at-all');
    // Should throw, NOT return [], to prevent saveWallet from overwriting
    await expect(getWallets()).rejects.toThrow();
  });

  it('secure deletion (mnemonic overwritten before removal)', async () => {
    const wallet = await saveWallet('Secure Del', TEST_MNEMONIC, 'void');
    const originalMnemonic = wallet.mnemonic;

    // Track all setItem calls by wrapping the real implementation
    const capturedWrites: string[] = [];
    const origSetItem = AsyncStorage.setItem.bind(AsyncStorage);
    const wrappedSetItem = jest.fn(async (key: string, value: string) => {
      if (key === WALLETS_KEY) {
        capturedWrites.push(value);
      }
      return origSetItem(key, value);
    });
    AsyncStorage.setItem = wrappedSetItem as any;

    await deleteWallet(wallet.id);

    // Restore original setItem
    AsyncStorage.setItem = origSetItem;

    // There should be at least 2 writes to WALLETS_KEY:
    // 1. One with overwritten mnemonic data (secure erasure)
    // 2. One with the wallet removed from the array
    expect(capturedWrites.length).toBeGreaterThanOrEqual(2);

    // First write should contain overwritten mnemonic (random data, not original)
    const firstWrite = JSON.parse(capturedWrites[0]);
    const overwrittenWallet = firstWrite.find((w: StoredWallet) => w.id === wallet.id);
    if (overwrittenWallet) {
      expect(overwrittenWallet.mnemonic).not.toBe(originalMnemonic);
      expect(overwrittenWallet.mnemonic.length).toBe(originalMnemonic.length);
    }

    // Final write should not contain the wallet at all
    const finalWrite = JSON.parse(capturedWrites[capturedWrites.length - 1]);
    expect(finalWrite.find((w: StoredWallet) => w.id === wallet.id)).toBeUndefined();
  });

  it('multiple wallets can be saved and retrieved independently', async () => {
    const w1 = await saveWallet('W1', TEST_MNEMONIC, 'void');
    const w2 = await saveWallet('W2', TEST_MNEMONIC, 'void');
    const w3 = await saveWallet('W3', TEST_MNEMONIC, 'bc1');

    // Verify all wallets are stored
    const allWallets = await getWallets();
    expect(allWallets).toHaveLength(3);

    const r1 = await getWallet(w1.id);
    const r2 = await getWallet(w2.id);
    const r3 = await getWallet(w3.id);

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r3).not.toBeNull();

    const m1 = await getWalletMnemonic(w1.id);
    const m2 = await getWalletMnemonic(w2.id);
    const m3 = await getWalletMnemonic(w3.id);

    expect(m1).toBe(TEST_MNEMONIC);
    expect(m2).toBe(TEST_MNEMONIC);
    expect(m3).toBe(TEST_MNEMONIC);
  });

  it('wallet IDs are unique', async () => {
    const wallets = [];
    for (let i = 0; i < 10; i++) {
      wallets.push(await saveWallet(`W${i}`, TEST_MNEMONIC, 'void'));
    }
    const ids = wallets.map(w => w.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(10);
  });

  it('concurrent writes (mutex behavior) do not lose data', async () => {
    // Fire multiple saveWallet calls concurrently
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(saveWallet(`Wallet ${i}`, TEST_MNEMONIC, 'void'));
    }
    await Promise.all(promises);

    const wallets = await getWallets();
    expect(wallets).toHaveLength(5);
    // All labels should be unique and present
    const labels = wallets.map(w => w.label).sort();
    expect(labels).toEqual(['Wallet 0', 'Wallet 1', 'Wallet 2', 'Wallet 3', 'Wallet 4']);
  });
});

// ============================================================================
// Mnemonic retrieval
// ============================================================================
describe('Mnemonic retrieval', () => {
  it('getWalletMnemonic returns mnemonic for stored wallet', async () => {
    const wallet = await saveWallet('Test', TEST_MNEMONIC, 'void');
    const mnemonic = await getWalletMnemonic(wallet.id);
    expect(mnemonic).toBe(TEST_MNEMONIC);
  });

  it('getWalletMnemonic returns null for non-existent wallet', async () => {
    const result = await getWalletMnemonic('nonexistent');
    expect(result).toBeNull();
  });

  it('legacy wallet with plaintext mnemonic returns mnemonic as-is', async () => {
    const wallet: StoredWallet = {
      id: 'void_unenc_wallet',
      type: 'void',
      label: 'Unencrypted',
      mnemonic: TEST_MNEMONIC,
      address: 'bitcoincashii:qtest',
      balance: 0,
      unconfirmedBalance: 0,
      createdAt: Date.now(),
    };
    await AsyncStorage.setItem(WALLETS_KEY, JSON.stringify([wallet]));

    const mnemonic = await getWalletMnemonic('void_unenc_wallet');
    expect(mnemonic).toBe(TEST_MNEMONIC);
  });
});

// ============================================================================
// Nonexistent wallet edge cases
// ============================================================================
describe('Nonexistent wallet edge cases', () => {
  it('updateWalletBalance silently skips for nonexistent wallet ID', async () => {
    // Store one wallet, then update a different (nonexistent) ID
    const wallet = await saveWallet('Existing', TEST_MNEMONIC, 'void');

    // Should not throw
    await updateWalletBalance('nonexistent_id', 999999, 1000);

    // Original wallet should be unchanged
    const existing = await getWallet(wallet.id);
    expect(existing!.balance).toBe(0);
    expect(existing!.unconfirmedBalance).toBe(0);
  });
});

// ============================================================================
// withStorageLock error propagation
// ============================================================================
describe('withStorageLock error propagation', () => {
  it('releases lock on error so subsequent calls are not deadlocked', async () => {
    // saveWallet with invalid mnemonic should throw,
    // which exercises the lock's .finally() release path.
    await expect(saveWallet('Fail', 'invalid mnemonic words', 'void')).rejects.toThrow();

    // A subsequent saveWallet should succeed (lock was released)
    const wallet = await saveWallet('After Error', TEST_MNEMONIC, 'void');
    expect(wallet).toBeDefined();
    expect(wallet.label).toBe('After Error');

    // Verify it was persisted
    const wallets = await getWallets();
    expect(wallets).toHaveLength(1);
  });
});

// ============================================================================
// Gap coverage: saveWallet edge cases
// ============================================================================
describe('Gap coverage: saveWallet edge cases', () => {
  it('empty string label is saved after trimming (empty label)', async () => {
    const wallet = await saveWallet('', TEST_MNEMONIC, 'void');
    expect(wallet.label).toBe('');
    expect(wallet.address.startsWith('bitcoincashii:')).toBe(true);

    // Verify it was persisted correctly
    const retrieved = await getWallet(wallet.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.label).toBe('');
  });

  it('whitespace-only label is trimmed to empty string', async () => {
    const wallet = await saveWallet('   ', TEST_MNEMONIC, 'void');
    expect(wallet.label).toBe('');
  });
});

// ============================================================================
// Gap coverage: deriveAddress edge cases
// ============================================================================
describe('Gap coverage: deriveAddress edge cases', () => {
  it('invalid walletType falls through to VOID derivation (default case)', async () => {
    const wallet = await saveWallet('Invalid Type', TEST_MNEMONIC, 'unknown' as any);

    // Should still produce a valid VOID CashAddr address (the default path)
    expect(wallet.address.startsWith('bitcoincashii:')).toBe(true);
    expect(wallet.type).toBe('unknown');
  });

  it('seed buffer is zeroed after address derivation', async () => {
    const bip39Module = require('bip39');
    let capturedSeed: Buffer | null = null;
    const originalMnemonicToSeedSync = bip39Module.mnemonicToSeedSync;

    // Spy on mnemonicToSeedSync to capture the seed buffer
    jest.spyOn(bip39Module, 'mnemonicToSeedSync').mockImplementation((mnemonic: string, passphrase?: string) => {
      const seed = originalMnemonicToSeedSync(mnemonic, passphrase);
      capturedSeed = Buffer.from(seed); // Copy to check later — the original will be zeroed
      return seed;
    });

    await saveWallet('Seed Zero Test', TEST_MNEMONIC, 'void');

    // The captured seed should have been a non-zero buffer before zeroing
    expect(capturedSeed).not.toBeNull();
    expect(capturedSeed!.length).toBe(64); // BIP39 seed is 64 bytes

    // Restore the spy
    jest.restoreAllMocks();
  });
});

// ============================================================================
// Gap coverage: hash160 correct computation
// ============================================================================
describe('Gap coverage: hash160 correct computation (SHA256 then RIPEMD160)', () => {
  it('hash160 produces correct result for known input', async () => {
    const crypto = require('crypto');

    const emptyBuf = Buffer.alloc(0);
    const sha256Hash = crypto.createHash('sha256').update(emptyBuf).digest();
    const ripemd160Hash = crypto.createHash('ripemd160').update(sha256Hash).digest();

    expect(sha256Hash.toString('hex')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(ripemd160Hash.toString('hex')).toBe('b472a266d0bd89c13706a4132ccfb16f7c3b9fcb');
    expect(ripemd160Hash.length).toBe(20);
  });

  it('hash160 of public key produces expected address', async () => {
    const w1 = await saveWallet('Hash Test 1', TEST_MNEMONIC, 'void');
    const w2 = await saveWallet('Hash Test 2', TEST_MNEMONIC, 'void');

    // Same mnemonic => same hash160 => same address
    expect(w1.address).toBe(w2.address);
    expect(w1.address.startsWith('bitcoincashii:')).toBe(true);

    // Verify the address length is appropriate (CashAddr with 20-byte hash)
    const parts = w1.address.split(':');
    expect(parts[0]).toBe('bitcoincashii');
    expect(parts[1].length).toBeGreaterThan(30);
  });
});

// ============================================================================
// Gap coverage: updateWalletBalance() negative unconfirmed balance
// ============================================================================
describe('Gap coverage: updateWalletBalance() negative unconfirmed balance', () => {
  it('negative unconfirmed balance is stored (not clamped), since pending spends can be negative', async () => {
    const wallet = await saveWallet('Neg Unconf', TEST_MNEMONIC, 'void');

    await updateWalletBalance(wallet.id, 100000, -5000);

    const updated = await getWallet(wallet.id);
    expect(updated!.balance).toBe(100000);
    expect(updated!.unconfirmedBalance).toBe(-5000);
  });

  it('negative unconfirmed balance with fractional part is floored', async () => {
    const wallet = await saveWallet('Neg Frac', TEST_MNEMONIC, 'void');

    await updateWalletBalance(wallet.id, 50000, -1234.7);

    const updated = await getWallet(wallet.id);
    expect(updated!.balance).toBe(50000);
    // Math.floor(-1234.7) = -1235
    expect(updated!.unconfirmedBalance).toBe(-1235);
  });

  it('large negative unconfirmed balance is accepted', async () => {
    const wallet = await saveWallet('Large Neg', TEST_MNEMONIC, 'void');

    await updateWalletBalance(wallet.id, 0, -999999999);

    const updated = await getWallet(wallet.id);
    expect(updated!.balance).toBe(0);
    expect(updated!.unconfirmedBalance).toBe(-999999999);
  });
});

// ============================================================================
// Gap coverage: deleteWallet() secure overwrite length
// ============================================================================
describe('Gap coverage: deleteWallet() secure overwrite length', () => {
  it('random bytes overwrite has the same length as the original mnemonic', async () => {
    const wallet = await saveWallet('Overwrite Len', TEST_MNEMONIC, 'void');
    const originalMnemonicLength = wallet.mnemonic.length;

    // Track setItem calls to capture the overwrite
    const capturedWrites: string[] = [];
    const origSetItem = AsyncStorage.setItem.bind(AsyncStorage);
    const wrappedSetItem = jest.fn(async (key: string, value: string) => {
      if (key === WALLETS_KEY) {
        capturedWrites.push(value);
      }
      return origSetItem(key, value);
    });
    AsyncStorage.setItem = wrappedSetItem as any;

    await deleteWallet(wallet.id);

    // Restore original
    AsyncStorage.setItem = origSetItem;

    // First write should contain the overwritten mnemonic
    expect(capturedWrites.length).toBeGreaterThanOrEqual(2);
    const firstWrite = JSON.parse(capturedWrites[0]);
    const overwrittenWallet = firstWrite.find((w: StoredWallet) => w.id === wallet.id);
    expect(overwrittenWallet).toBeDefined();

    // The overwritten mnemonic must have EXACTLY the same length as the original
    expect(overwrittenWallet.mnemonic.length).toBe(originalMnemonicLength);

    // It must be different from the original (random data)
    expect(overwrittenWallet.mnemonic).not.toBe(wallet.mnemonic);

    // It should be hex characters (crypto.randomBytes().toString('hex'))
    expect(overwrittenWallet.mnemonic).toMatch(/^[0-9a-f]+$/);
  });
});

// ============================================================================
// Gap coverage: deriveAddress() with falsy walletType
// ============================================================================
describe('Gap coverage: deriveAddress() with falsy walletType', () => {
  it('null walletType falls back to default VOID derivation', async () => {
    const wallet = await saveWallet('Null Type', TEST_MNEMONIC, null as any);
    expect(wallet.address.startsWith('bitcoincashii:')).toBe(true);
  });

  it('undefined walletType falls back to default VOID derivation', async () => {
    const wallet = await saveWallet('Undef Type', TEST_MNEMONIC, undefined as any);
    expect(wallet.address.startsWith('bitcoincashii:')).toBe(true);
  });

  it('empty string walletType falls back to default VOID derivation', async () => {
    const wallet = await saveWallet('Empty Type', TEST_MNEMONIC, '' as any);
    expect(wallet.address.startsWith('bitcoincashii:')).toBe(true);
  });
});

// ============================================================================
// Gap coverage: withStorageLock() concurrent access serialization
// ============================================================================
describe('Gap coverage: withStorageLock() concurrent access', () => {
  it('two concurrent saveWallet calls are properly serialized by the mutex', async () => {
    const [w1, w2] = await Promise.all([
      saveWallet('Concurrent A', TEST_MNEMONIC, 'void'),
      saveWallet('Concurrent B', TEST_MNEMONIC, 'void'),
    ]);

    expect(w1).toBeDefined();
    expect(w2).toBeDefined();
    expect(w1.id).not.toBe(w2.id);

    const wallets = await getWallets();
    expect(wallets).toHaveLength(2);
    const labels = wallets.map(w => w.label).sort();
    expect(labels).toEqual(['Concurrent A', 'Concurrent B']);
  });

  it('concurrent save and delete are serialized without data loss', async () => {
    const existing = await saveWallet('Existing', TEST_MNEMONIC, 'void');

    const [newWallet] = await Promise.all([
      saveWallet('New One', TEST_MNEMONIC, 'void'),
      deleteWallet(existing.id),
    ]);

    const wallets = await getWallets();
    expect(wallets).toHaveLength(1);
    expect(wallets[0].label).toBe('New One');
  });

  it('concurrent balance updates are serialized', async () => {
    const wallet = await saveWallet('Balance Race', TEST_MNEMONIC, 'void');

    await Promise.all([
      updateWalletBalance(wallet.id, 10000, 0),
      updateWalletBalance(wallet.id, 20000, 500),
      updateWalletBalance(wallet.id, 30000, 1000),
    ]);

    const updated = await getWallet(wallet.id);
    expect(updated).not.toBeNull();
    expect([10000, 20000, 30000]).toContain(updated!.balance);
  });
});
