import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  saveWallet,
  getWallets,
  getWallet,
  deleteWallet,
  getWalletMnemonic,
  updateWalletBalance,
} from '../../class/void-wallet-storage';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLETS_KEY = '@void_wallets';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('Mnemonic Storage', () => {
  it('saveWallet stores mnemonic in plaintext (app-level encryption handles security)', async () => {
    const wallet = await saveWallet('Test', TEST_MNEMONIC, 'void');
    expect(wallet.mnemonic).toBe(TEST_MNEMONIC);
  });

  it('getWalletMnemonic returns original mnemonic', async () => {
    const wallet = await saveWallet('Test', TEST_MNEMONIC, 'void');
    const mnemonic = await getWalletMnemonic(wallet.id);
    expect(mnemonic).toBe(TEST_MNEMONIC);
  });

  it('getWalletMnemonic returns null for non-existent wallet', async () => {
    const result = await getWalletMnemonic('nonexistent_id');
    expect(result).toBeNull();
  });
});

describe('Input Validation', () => {
  it('saveWallet throws if mnemonic is invalid (not BIP39-valid)', async () => {
    await expect(saveWallet('Test', 'not a valid mnemonic phrase at all', 'void')).rejects.toThrow('Invalid mnemonic');
  });

  it('saveWallet trims mnemonic whitespace', async () => {
    const paddedMnemonic = '  ' + TEST_MNEMONIC + '  ';
    const wallet = await saveWallet('Test', paddedMnemonic, 'void');
    const mnemonic = await getWalletMnemonic(wallet.id);
    expect(mnemonic).toBe(TEST_MNEMONIC);
    // No leading/trailing whitespace
    expect(mnemonic).not.toMatch(/^\s/);
    expect(mnemonic).not.toMatch(/\s$/);
  });

  it('saveWallet trims label whitespace', async () => {
    const wallet = await saveWallet('  My Wallet  ', TEST_MNEMONIC, 'void');
    expect(wallet.label).toBe('My Wallet');
  });

  it('updateWalletBalance rejects NaN balance', async () => {
    const wallet = await saveWallet('Test', TEST_MNEMONIC, 'void');
    await updateWalletBalance(wallet.id, NaN, 0);
    // Balance should remain unchanged (0) since NaN is silently rejected
    const updated = await getWallet(wallet.id);
    expect(updated!.balance).toBe(0);
  });

  it('updateWalletBalance rejects Infinity balance', async () => {
    const wallet = await saveWallet('Test', TEST_MNEMONIC, 'void');
    await updateWalletBalance(wallet.id, Infinity, 0);
    // Balance should remain unchanged (0) since Infinity is silently rejected
    const updated = await getWallet(wallet.id);
    expect(updated!.balance).toBe(0);
  });

  it('updateWalletBalance rejects negative confirmed balance', async () => {
    const wallet = await saveWallet('Test', TEST_MNEMONIC, 'void');
    await updateWalletBalance(wallet.id, -100, 0);
    // Negative confirmed balance is clamped to 0 via Math.max(0, ...)
    const updated = await getWallet(wallet.id);
    expect(updated!.balance).toBe(0);
  });
});

describe('Legacy Wallet Handling', () => {
  it('getWalletMnemonic returns mnemonic for legacy wallet', async () => {
    const legacyWallet = {
      id: 'legacy_test',
      type: 'void' as const,
      label: 'Legacy',
      mnemonic: TEST_MNEMONIC,
      address: 'bitcoincashii:qtest',
      balance: 0,
      unconfirmedBalance: 0,
      createdAt: Date.now(),
    };
    await AsyncStorage.setItem(WALLETS_KEY, JSON.stringify([legacyWallet]));

    const mnemonic = await getWalletMnemonic('legacy_test');
    expect(mnemonic).toBe(TEST_MNEMONIC);
  });
});

describe('Deletion Security', () => {
  it('deleteWallet removes wallet from storage', async () => {
    const wallet = await saveWallet('Test', TEST_MNEMONIC, 'void');
    await deleteWallet(wallet.id);
    const wallets = await getWallets();
    expect(wallets.length).toBe(0);
  });

  it('after deleteWallet, getWallet returns null for deleted ID', async () => {
    const wallet = await saveWallet('Test', TEST_MNEMONIC, 'void');
    const id = wallet.id;
    await deleteWallet(id);
    const result = await getWallet(id);
    expect(result).toBeNull();
  });

  it('deleteWallet does not affect other wallets', async () => {
    const wallet1 = await saveWallet('Wallet 1', TEST_MNEMONIC, 'void');
    // Use a different valid mnemonic for wallet 2
    const mnemonic2 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
    const wallet2 = await saveWallet('Wallet 2', mnemonic2, 'void');

    await deleteWallet(wallet1.id);

    const remaining = await getWallets();
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(wallet2.id);
    expect(remaining[0].label).toBe('Wallet 2');

    // Verify wallet2 mnemonic is still accessible
    const decrypted = await getWalletMnemonic(wallet2.id);
    expect(decrypted).toBe(mnemonic2);
  });
});

describe('Concurrent Access', () => {
  it('multiple concurrent saveWallet calls do not lose data (storage lock test)', async () => {
    const mnemonics = [
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
      'legal winner thank year wave sausage worth useful legal winner thank yellow',
    ];

    // Fire all three saves concurrently
    const results = await Promise.all(
      mnemonics.map((m, i) => saveWallet(`Wallet ${i}`, m, 'void')),
    );

    expect(results.length).toBe(3);

    const wallets = await getWallets();
    expect(wallets.length).toBe(3);

    // Each wallet should be present
    const ids = wallets.map(w => w.id);
    for (const r of results) {
      expect(ids).toContain(r.id);
    }
  });

  it('saveWallet followed by immediate getWallets returns the saved wallet', async () => {
    const wallet = await saveWallet('Immediate', TEST_MNEMONIC, 'void');
    const wallets = await getWallets();
    expect(wallets.length).toBe(1);
    expect(wallets[0].id).toBe(wallet.id);
    expect(wallets[0].label).toBe('Immediate');
  });
});

describe('Address Derivation', () => {
  it('saveWallet with type void derives a bitcoincashii: prefixed address', async () => {
    const wallet = await saveWallet('VOID', TEST_MNEMONIC, 'void');
    expect(wallet.address.startsWith('bitcoincashii:')).toBe(true);
  });

  it('saveWallet with type void derives a legacy address (starts with 1)', async () => {
    const wallet = await saveWallet('VOID', TEST_MNEMONIC, 'void');
    expect(wallet.address.startsWith('1')).toBe(true);
  });
});
