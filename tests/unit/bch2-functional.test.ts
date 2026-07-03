/**
 * VOID Functional Tests — End-to-End Wallet Operations
 *
 * Tests the full wallet lifecycle by mocking the Electrum layer:
 * 1. Wallet lifecycle: create → address derivation → balance → send → verify
 * 2. Import/restore: mnemonic import → address verification → balance fetch
 * 3. Edge cases: zero balance, dust, max send, invalid address, locale input
 * 4. Storage operations: save multiple → list → update → delete → verify
 * 5. Airdrop claim: mock scan → verify claim result structure
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as bip39 from 'bip39';
import BIP32Factory from 'bip32';
import ecc from '../../blue_modules/noble_ecc';

const bip32 = BIP32Factory(ecc);
const crypto = require('crypto');
const bs58check = require('bs58check');

// ---- Constants ---------------------------------------------------------------
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_ALT = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const TEST_PASSWORD = 'testpassword123';
const WALLETS_KEY = '@void_wallets';

// ---- Electrum Mocks ----------------------------------------------------------
const mockGetUtxosByAddress = jest.fn();
const mockGetVOIDUtxos = jest.fn();
const mockGetUtxosByScripthash = jest.fn();
const mockBroadcastTransaction = jest.fn();
const mockBroadcastVOIDTransaction = jest.fn();
const mockGetBalanceByAddress = jest.fn();
const mockGetBalanceByScripthash = jest.fn();
const mockGetVOIDBalance = jest.fn();
const mockGetVOIDBalanceByScripthash = jest.fn();

jest.mock('../../blue_modules/VoidElectrum', () => ({
  getUtxosByAddress: (...args: any[]) => mockGetUtxosByAddress(...args),
  getVOIDUtxos: (...args: any[]) => mockGetVOIDUtxos(...args),
  getUtxosByScripthash: (...args: any[]) => mockGetUtxosByScripthash(...args),
  broadcastTransaction: (...args: any[]) => mockBroadcastTransaction(...args),
  broadcastVOIDTransaction: (...args: any[]) => mockBroadcastVOIDTransaction(...args),
  getBalanceByAddress: (...args: any[]) => mockGetBalanceByAddress(...args),
  getBalanceByScripthash: (...args: any[]) => mockGetBalanceByScripthash(...args),
  getVoidBalance: (...args: any[]) => mockGetVOIDBalance(...args),
  getVoidBalanceByScripthash: (...args: any[]) => mockGetVOIDBalanceByScripthash(...args),
  connectMain: jest.fn(),
}));

// Mock VoidWallet class for airdrop tests
jest.mock('../../class/wallets/void-wallet', () => {
  return {
    VoidWallet: jest.fn().mockImplementation(() => ({
      setSecret: jest.fn().mockReturnThis(),
      getAddress: jest.fn().mockReturnValue('bitcoincashii:qmockaddress'),
      fetchBalance: jest.fn().mockResolvedValue(undefined),
      prepareForSerialization: jest.fn(),
      balance: 50000,
      unconfirmed_balance: 0,
    })),
  };
});

// Import modules under test AFTER mocks
import { sendTransaction, decodeCashAddr } from '../../class/void-transaction';
import {
  saveWallet,
  getWallets,
  getWallet,
  deleteWallet,
  getWalletMnemonic,
  updateWalletBalance,
  StoredWallet,
} from '../../class/void-wallet-storage';
import {
  claimFromMnemonic,
  buildScanResult,
  getAntiGamingStatus,
  AirdropClaimResult,
  AirdropScanResult,
} from '../../class/void-airdrop';

// ---- CashAddr helpers (from void-transaction.test.ts pattern) ----------------
const CASHADDR_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CASHADDR_GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

function cashAddrPolymod(values: number[]): bigint {
  let chk = 1n;
  for (const value of values) {
    const top = chk >> 35n;
    chk = ((chk & 0x07ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i++) {
      if ((top >> BigInt(i)) & 1n) chk ^= CASHADDR_GENERATORS[i];
    }
  }
  return chk;
}

function encodeCashAddr(pubkeyHash: Buffer, type: number = 0): string {
  const prefix = 'bitcoincashii';
  const versionByte = (type << 3) | 0;
  const payload: number[] = [];
  let acc = versionByte;
  let bits = 8;
  for (const byte of pubkeyHash) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; payload.push((acc >> bits) & 0x1f); }
  }
  if (bits > 0) payload.push((acc << (5 - bits)) & 0x1f);

  const prefixData: number[] = [];
  for (const c of prefix) prefixData.push(c.charCodeAt(0) & 0x1f);
  prefixData.push(0);
  const values = [...prefixData, ...payload, 0, 0, 0, 0, 0, 0, 0, 0];
  const pm = cashAddrPolymod(values) ^ 1n;
  const checksum: number[] = [];
  for (let i = 0; i < 8; i++) checksum.push(Number((pm >> BigInt(5 * (7 - i))) & 0x1fn));

  let result = prefix + ':';
  for (const v of [...payload, ...checksum]) result += CASHADDR_CHARSET[v];
  return result;
}

function hash160(data: Buffer): Buffer {
  const sha256Hash = crypto.createHash('sha256').update(data).digest();
  return crypto.createHash('ripemd160').update(sha256Hash).digest();
}

function fakeTxid(n: number): string {
  const hex = n.toString(16).padStart(2, '0');
  return hex.repeat(32);
}

// ---- Pre-derived test addresses ----------------------------------------------
let SENDER_CASHADDR: string;
let DEST_CASHADDR: string;

beforeAll(async () => {
  const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
  const root = bip32.fromSeed(seed);

  // Sender address (m/44'/145'/0'/0/0) — matches what sendTransaction derives
  const senderChild = root.derivePath("m/44'/145'/0'/0/0");
  const senderPkh = hash160(Buffer.from(senderChild.publicKey));
  SENDER_CASHADDR = encodeCashAddr(senderPkh, 0);

  // Destination address (m/44'/145'/0'/0/1) — different from sender
  const destChild = root.derivePath("m/44'/145'/0'/0/1");
  const destPkh = hash160(Buffer.from(destChild.publicKey));
  DEST_CASHADDR = encodeCashAddr(destPkh, 0);
});

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockBroadcastTransaction.mockResolvedValue('abcd'.repeat(16));
  mockBroadcastVOIDTransaction.mockResolvedValue('ef01'.repeat(16));
  mockGetBalanceByAddress.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
  mockGetBalanceByScripthash.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
  mockGetVOIDBalance.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
  mockGetVOIDBalanceByScripthash.mockResolvedValue({ confirmed: 0, unconfirmed: 0 });
});

// ============================================================================
// 1. Wallet Lifecycle — End to End
// ============================================================================
describe('Wallet lifecycle (create -> address -> balance -> send -> verify)', () => {
  it('full lifecycle: create wallet, derive address, fetch balance, send tx, update balance', async () => {
    // Step 1: Create wallet
    const wallet = await saveWallet('Main Wallet', TEST_MNEMONIC, 'void');
    expect(wallet.id).toMatch(/^void_/);
    expect(wallet.label).toBe('Main Wallet');
    expect(wallet.type).toBe('void');
    expect(wallet.balance).toBe(0);

    // Step 2: Verify address derivation — CashAddr with correct prefix
    expect(wallet.address.startsWith('bitcoincashii:')).toBe(true);
    const addrParts = wallet.address.split(':');
    expect(addrParts).toHaveLength(2);
    expect(addrParts[1].length).toBeGreaterThan(30);

    // Step 3: Simulate balance fetch — update storage
    await updateWalletBalance(wallet.id, 1_000_000, 0);
    const walletAfterBalance = await getWallet(wallet.id);
    expect(walletAfterBalance!.balance).toBe(1_000_000);
    expect(walletAfterBalance!.unconfirmedBalance).toBe(0);

    // Step 4: Send a transaction
    const utxo = { txid: fakeTxid(1), vout: 0, value: 1_000_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const txResult = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 500_000, 1, false);
    expect(txResult.txid).toBeTruthy();
    expect(txResult.hex).toBeTruthy();
    expect(mockBroadcastTransaction).toHaveBeenCalledTimes(1);

    // Step 5: Update balance post-send
    // 1 input, 2 outputs: 10 + 148 + 68 = 226 fee, change = 1_000_000 - 500_000 - 226 = 499_774
    await updateWalletBalance(wallet.id, 499_774, 0);
    const walletAfterSend = await getWallet(wallet.id);
    expect(walletAfterSend!.balance).toBe(499_774);
  });

  it('lifecycle with unconfirmed balance: create, add confirmed + unconfirmed, verify', async () => {
    const wallet = await saveWallet('Unconf Wallet', TEST_MNEMONIC, 'void');

    // Simulate receiving coins — confirmed + unconfirmed
    await updateWalletBalance(wallet.id, 500_000, 100_000);
    const w = await getWallet(wallet.id);
    expect(w!.balance).toBe(500_000);
    expect(w!.unconfirmedBalance).toBe(100_000);
  });

  it('multiple sequential sends from the same wallet', async () => {
    const wallet = await saveWallet('Multi-Send', TEST_MNEMONIC, 'void');
    await updateWalletBalance(wallet.id, 5_000_000, 0);

    // First send
    mockGetUtxosByAddress.mockResolvedValueOnce([{ txid: fakeTxid(10), vout: 0, value: 5_000_000 }]);
    const tx1 = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 1_000_000, 1, false);
    expect(tx1.txid).toBeTruthy();

    // Simulate balance update after first send
    // Fee = 226 (1-in 2-out), change = 5_000_000 - 1_000_000 - 226 = 3_999_774
    await updateWalletBalance(wallet.id, 3_999_774, 0);

    // Second send from the change — return a different txid from broadcast
    mockBroadcastTransaction.mockResolvedValueOnce('beef'.repeat(16));
    mockGetUtxosByAddress.mockResolvedValueOnce([{ txid: fakeTxid(11), vout: 1, value: 3_999_774 }]);
    const tx2 = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 1_000_000, 1, false);
    expect(tx2.txid).toBeTruthy();
    expect(tx2.txid).not.toBe(tx1.txid);

    expect(mockBroadcastTransaction).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// 2. Import / Restore from Mnemonic
// ============================================================================
describe('Import/restore from mnemonic', () => {
  it('importing same mnemonic produces same address', async () => {
    const w1 = await saveWallet('Original', TEST_MNEMONIC, 'void');
    const w2 = await saveWallet('Restored', TEST_MNEMONIC, 'void');

    expect(w1.address).toBe(w2.address);
    expect(w1.address.startsWith('bitcoincashii:')).toBe(true);
  });

  it('restored wallet can retrieve balance', async () => {
    // Create original wallet
    const original = await saveWallet('Original', TEST_MNEMONIC, 'void');
    await updateWalletBalance(original.id, 750_000, 10_000);

    // "Restore" wallet from same mnemonic
    const restored = await saveWallet('Restored', TEST_MNEMONIC, 'void');
    expect(restored.address).toBe(original.address);

    // Simulate fetching balance for restored wallet (same address, same balance)
    await updateWalletBalance(restored.id, 750_000, 10_000);
    const restoredWallet = await getWallet(restored.id);
    expect(restoredWallet!.balance).toBe(750_000);
    expect(restoredWallet!.unconfirmedBalance).toBe(10_000);
  });

  it('restored wallet can decrypt mnemonic correctly', async () => {
    const wallet = await saveWallet('Decrypt Test', TEST_MNEMONIC, 'void');
    const decrypted = await getWalletMnemonic(wallet.id);
    expect(decrypted).toBe(TEST_MNEMONIC);
  });

  it('different mnemonic produces different address', async () => {
    const w1 = await saveWallet('Mnemonic 1', TEST_MNEMONIC, 'void');
    const w2 = await saveWallet('Mnemonic 2', TEST_MNEMONIC_ALT, 'void');
    expect(w1.address).not.toBe(w2.address);
  });

  it('imported wallet can send transactions after restore', async () => {
    // Restore wallet
    const wallet = await saveWallet('Restored Sender', TEST_MNEMONIC, 'void');
    await updateWalletBalance(wallet.id, 2_000_000, 0);

    // Verify mnemonic can be decrypted
    const mnemonic = await getWalletMnemonic(wallet.id);
    expect(mnemonic).toBe(TEST_MNEMONIC);

    // Send from restored wallet
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(20), vout: 0, value: 2_000_000 }]);
    const result = await sendTransaction(mnemonic!, DEST_CASHADDR, 1_000_000, 1, false);
    expect(result.txid).toBeTruthy();
  });

  it('VOID wallet type uses different derivation path than VOID', async () => {
    const voidWallet = await saveWallet('VOID', TEST_MNEMONIC, 'void');
    const voidWallet = await saveWallet('VOID', TEST_MNEMONIC, 'void');

    // VOID uses CashAddr, VOID uses legacy
    expect(voidWallet.address.startsWith('bitcoincashii:')).toBe(true);
    expect(voidWallet.address).toMatch(/^[13]/);
    expect(voidWallet.address).not.toBe(voidWallet.address);
  });
});

// ============================================================================
// 3. Edge Cases — Send Operations
// ============================================================================
describe('Edge cases: zero balance sends', () => {
  it('sending from empty UTXO set throws "No UTXOs available"', async () => {
    mockGetUtxosByAddress.mockResolvedValue([]);
    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 1000, 1, false),
    ).rejects.toThrow(/No UTXOs available/);
  });

  it('sending more than balance throws "Insufficient funds"', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(30), vout: 0, value: 500 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false),
    ).rejects.toThrow(/Insufficient funds/);
  });
});

describe('Edge cases: dust amount sends', () => {
  it('545 sats should fail (below dust threshold)', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(31), vout: 0, value: 100_000 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 545, 1, false),
    ).rejects.toThrow(/dust threshold/);
  });

  it('546 sats should succeed (at dust threshold)', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(32), vout: 0, value: 100_000 }]);
    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 546, 1, false);
    expect(result.txid).toBeTruthy();
    expect(result.hex).toBeTruthy();
  });

  it('1 sat should fail (far below dust)', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(33), vout: 0, value: 100_000 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 1, 1, false),
    ).rejects.toThrow(/dust threshold/);
  });

  it('0 sats should fail (below dust)', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(34), vout: 0, value: 100_000 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 0, 1, false),
    ).rejects.toThrow(/dust threshold/);
  });
});

describe('Edge cases: maximum balance send (sweep)', () => {
  it('sending all funds minus fee leaves zero change (absorbed as fee)', async () => {
    // 1-in 1-out size: 10 + 148 + 34 = 192, fee at 1 sat/byte = 192
    // Total input: 10_000. Send 10_000 - 192 = 9_808.
    // Change with 2-out: 10_000 - 9_808 - 226 = -34 (negative, but let's check 1-out)
    // With 1-out: fee = 192, change = 10_000 - 9_808 - 192 = 0 (no change output)
    // Actually: with 2-out fee=226, tentativeChange = 10000 - 9808 - 226 = -34 <= 546
    // So hasChange=false, 1-out fee = 192, and totalInput(10000) >= amount(9808) + fee(192) = 10000. Just enough.
    const utxo = { txid: fakeTxid(35), vout: 0, value: 10_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 9_808, 1, false);
    expect(result.hex).toBeTruthy();

    // Parse: should be 1 output (no change)
    const txBuf = Buffer.from(result.hex, 'hex');
    let offset = 5; // version(4) + varint_inputcount(1)
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4;
    const outputCount = txBuf[offset];
    expect(outputCount).toBe(1);
  });

  it('dust change is absorbed into fee instead of creating dust output', async () => {
    // 1-in 2-out: fee=226, change = 50_600 - 50_000 - 226 = 374 (<=546, dust)
    // Falls to 1-in 1-out: fee=192, all extra goes to fee
    const utxo = { txid: fakeTxid(36), vout: 0, value: 50_600 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4;
    const outputCount = txBuf[offset];
    expect(outputCount).toBe(1); // dust absorbed
  });
});

describe('Edge cases: invalid address rejection', () => {
  it('rejects sending VOID to a SegWit (bc1) address', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(40), vout: 0, value: 100_000 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 50_000, 1, false),
    ).rejects.toThrow(/Cannot send VOID to a SegWit/);
  });

  it('rejects sending to a bitcoincash: (BCH) prefixed address', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(41), vout: 0, value: 100_000 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, 'bitcoincash:qr5agtachyxvrwxe76vsd4dr35q4rl74xqa0evzaw0', 50_000, 1, false),
    ).rejects.toThrow(/bitcoincashii/);
  });

  it('rejects invalid CashAddr characters', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(42), vout: 0, value: 100_000 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, 'bitcoincashii:INVALID!!CHARS', 50_000, 1, false),
    ).rejects.toThrow();
  });

  it('rejects CashAddr with bad checksum', async () => {
    // Valid address with last char changed to break checksum
    const validAddr = DEST_CASHADDR;
    const lastChar = validAddr[validAddr.length - 1];
    const badChar = lastChar === 'q' ? 'p' : 'q';
    const badAddr = validAddr.slice(0, -1) + badChar;

    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(43), vout: 0, value: 100_000 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, badAddr, 50_000, 1, false),
    ).rejects.toThrow();
  });

  it('rejects empty address', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(44), vout: 0, value: 100_000 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, '', 50_000, 1, false),
    ).rejects.toThrow();
  });
});

describe('Edge cases: European locale decimal input (comma as separator)', () => {
  it('comma-separated amount strings are not valid integer amounts', () => {
    // This tests the principle that UI should convert "1.234,56" -> integer sats
    // before passing to sendTransaction. The transaction builder expects integer sats.
    const euroAmount = '1.234,56';

    // parseFloat with comma returns NaN for European format
    const parsed = parseFloat(euroAmount.replace(',', '.').replace(/\./g, (m, i, s) => {
      // Only keep the last dot as decimal separator
      return i === s.lastIndexOf('.') ? '.' : '';
    }));

    // After proper parsing: "1.234,56" -> "1234.56" -> 1234.56 -> 123456 sats
    // Verify the parser produces a valid number
    expect(Number.isFinite(parsed)).toBe(true);
    expect(Math.round(parsed * 100)).toBe(123456);
  });

  it('integer sats input does not accept floating point', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(45), vout: 0, value: 100_000 }]);
    // sendTransaction expects integer sats — passing a float is handled
    // by the "Invalid amount" check (amountSats must be integer)
    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000.5, 1, false),
    ).rejects.toThrow(/Invalid amount/);
  });

  it('negative amount is rejected', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(46), vout: 0, value: 100_000 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, -1000, 1, false),
    ).rejects.toThrow(/Invalid amount/);
  });
});

// ============================================================================
// 4. Storage Operations
// ============================================================================
describe('Storage operations: save multiple, list, update, delete, verify', () => {
  it('saves 3 wallets and lists all correctly', async () => {
    const w1 = await saveWallet('Wallet Alpha', TEST_MNEMONIC, 'void');
    const w2 = await saveWallet('Wallet Beta', TEST_MNEMONIC, 'void');
    const w3 = await saveWallet('Wallet Gamma', TEST_MNEMONIC_ALT, 'void');

    const wallets = await getWallets();
    expect(wallets).toHaveLength(3);
    expect(wallets.map(w => w.label)).toEqual(['Wallet Alpha', 'Wallet Beta', 'Wallet Gamma']);
  });

  it('update balance on specific wallet does not affect others', async () => {
    const w1 = await saveWallet('W1', TEST_MNEMONIC, 'void');
    const w2 = await saveWallet('W2', TEST_MNEMONIC_ALT, 'void');

    await updateWalletBalance(w1.id, 1_000_000, 50_000);

    const updated1 = await getWallet(w1.id);
    const updated2 = await getWallet(w2.id);
    expect(updated1!.balance).toBe(1_000_000);
    expect(updated1!.unconfirmedBalance).toBe(50_000);
    expect(updated2!.balance).toBe(0);
    expect(updated2!.unconfirmedBalance).toBe(0);
  });

  it('delete one wallet preserves others with correct balances', async () => {
    const w1 = await saveWallet('Keep Me', TEST_MNEMONIC, 'void');
    const w2 = await saveWallet('Delete Me', TEST_MNEMONIC_ALT, 'void');
    const w3 = await saveWallet('Also Keep', TEST_MNEMONIC, 'void');

    await updateWalletBalance(w1.id, 100_000, 0);
    await updateWalletBalance(w3.id, 200_000, 5_000);

    // Delete w2
    await deleteWallet(w2.id);

    // Verify remaining
    const wallets = await getWallets();
    expect(wallets).toHaveLength(2);
    expect(wallets.map(w => w.label).sort()).toEqual(['Also Keep', 'Keep Me']);

    // Verify balances are intact
    const kept1 = await getWallet(w1.id);
    const kept3 = await getWallet(w3.id);
    expect(kept1!.balance).toBe(100_000);
    expect(kept3!.balance).toBe(200_000);
    expect(kept3!.unconfirmedBalance).toBe(5_000);

    // Verify deleted wallet is gone
    const deleted = await getWallet(w2.id);
    expect(deleted).toBeNull();
  });

  it('deleted wallet mnemonic is securely overwritten before removal', async () => {
    const wallet = await saveWallet('Secure Del', TEST_MNEMONIC, 'void');
    const originalMnemonic = wallet.mnemonic;

    const capturedWrites: string[] = [];
    const origSetItem = AsyncStorage.setItem.bind(AsyncStorage);
    const wrappedSetItem = jest.fn(async (key: string, value: string) => {
      if (key === WALLETS_KEY) capturedWrites.push(value);
      return origSetItem(key, value);
    });
    AsyncStorage.setItem = wrappedSetItem as any;

    await deleteWallet(wallet.id);

    AsyncStorage.setItem = origSetItem;

    // Phase 1 write should overwrite mnemonic with random data
    expect(capturedWrites.length).toBeGreaterThanOrEqual(2);
    const phase1 = JSON.parse(capturedWrites[0]);
    const overwritten = phase1.find((w: StoredWallet) => w.id === wallet.id);
    if (overwritten) {
      expect(overwritten.mnemonic).not.toBe(originalMnemonic);
      expect(overwritten.mnemonic.length).toBe(originalMnemonic.length);
    }

    // Phase 2 write should not contain the wallet
    const phase2 = JSON.parse(capturedWrites[capturedWrites.length - 1]);
    expect(phase2.find((w: StoredWallet) => w.id === wallet.id)).toBeUndefined();
  });

  it('wallet IDs are unique across creation calls', async () => {
    const wallets = [];
    for (let i = 0; i < 5; i++) {
      wallets.push(await saveWallet(`W${i}`, TEST_MNEMONIC, 'void'));
    }
    const ids = new Set(wallets.map(w => w.id));
    expect(ids.size).toBe(5);
  });

  it('balance update with NaN is rejected (balance unchanged)', async () => {
    const w = await saveWallet('NaN Test', TEST_MNEMONIC, 'void');
    await updateWalletBalance(w.id, NaN, 0);
    const updated = await getWallet(w.id);
    expect(updated!.balance).toBe(0);
  });

  it('balance update with Infinity is rejected (balance unchanged)', async () => {
    const w = await saveWallet('Inf Test', TEST_MNEMONIC, 'void');
    await updateWalletBalance(w.id, Infinity, 0);
    const updated = await getWallet(w.id);
    expect(updated!.balance).toBe(0);
  });

  it('negative confirmed balance is clamped to zero', async () => {
    const w = await saveWallet('Neg Test', TEST_MNEMONIC, 'void');
    await updateWalletBalance(w.id, -500, 0);
    const updated = await getWallet(w.id);
    expect(updated!.balance).toBe(0);
  });

  it('negative unconfirmed balance is stored (pending spend)', async () => {
    const w = await saveWallet('Neg Unconf', TEST_MNEMONIC, 'void');
    await updateWalletBalance(w.id, 100_000, -5_000);
    const updated = await getWallet(w.id);
    expect(updated!.unconfirmedBalance).toBe(-5_000);
  });

  it('concurrent saves via Promise.all do not lose data', async () => {
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(saveWallet(`Concurrent ${i}`, TEST_MNEMONIC, 'void'));
    }
    await Promise.all(promises);

    const wallets = await getWallets();
    expect(wallets).toHaveLength(5);
    const labels = wallets.map(w => w.label).sort();
    expect(labels).toEqual([
      'Concurrent 0', 'Concurrent 1', 'Concurrent 2',
      'Concurrent 3', 'Concurrent 4',
    ]);
  });

  it('corrupted storage throws descriptive error', async () => {
    await AsyncStorage.setItem(WALLETS_KEY, '{not valid json!!!');
    await expect(getWallets()).rejects.toThrow(/Wallet data corrupted/);
  });
});

// ============================================================================
// 5. Airdrop Claim
// ============================================================================
describe('Airdrop claim: mock successful scan', () => {
  it('claimFromMnemonic returns success for address with balance', async () => {
    // First address on first path should have balance
    let callCount = 0;
    mockGetBalanceByAddress.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { confirmed: 100_000, unconfirmed: 0 };
      return { confirmed: 0, unconfirmed: 0 };
    });

    const results = await claimFromMnemonic(TEST_MNEMONIC);

    expect(results.length).toBeGreaterThanOrEqual(1);
    const claim = results[0];
    expect(claim.success).toBe(true);
    expect(claim.balance).toBe(100_000);
    expect(claim.voidAddress.startsWith('bitcoincashii:')).toBe(true);
    expect(claim.address).toBeTruthy(); // VOID legacy address
  });

  it('claimFromMnemonic returns failure for invalid mnemonic', async () => {
    const results = await claimFromMnemonic('invalid mnemonic words here');

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/Invalid mnemonic/);
  });

  it('claimFromMnemonic returns failure when no balance found', async () => {
    // All balance checks return 0 (default mock)
    const results = await claimFromMnemonic(TEST_MNEMONIC);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].balance).toBe(0);
    expect(results[0].error).toContain('No VOID balance found');
  });

  it('buildScanResult produces correct AirdropScanResult structure', () => {
    const claims: AirdropClaimResult[] = [
      {
        success: true,
        address: '1TestAddr',
        voidAddress: 'bitcoincashii:qtest1',
        balance: 50_000,
        voidBalance: 50_000,
        addressType: 'legacy',
        derivationPath: "m/44'/145'/0'/0/0",
      },
      {
        success: true,
        address: '1TestAddr2',
        voidAddress: 'bitcoincashii:qtest2',
        balance: 30_000,
        voidBalance: 20_000,
        addressType: 'legacy',
        derivationPath: "m/44'/0'/0'/0/0",
      },
    ];

    const scan = buildScanResult(claims);

    expect(scan.totalBalance).toBe(80_000);
    // airdropBalance = min(50000, 50000) + min(30000, 20000) = 50000 + 20000 = 70000
    expect(scan.airdropBalance).toBe(70_000);
    // postForkBalance = 80000 - 70000 = 10000
    expect(scan.postForkBalance).toBe(10_000);
    expect(scan.claims).toHaveLength(2);
  });

  it('buildScanResult filters out failed claims and zero-balance claims', () => {
    const claims: AirdropClaimResult[] = [
      {
        success: true,
        address: '1Good',
        voidAddress: 'bitcoincashii:qgood',
        balance: 100_000,
        voidBalance: 100_000,
      },
      {
        success: false,
        address: '1Bad',
        voidAddress: 'bitcoincashii:qbad',
        balance: 0,
        error: 'No balance',
      },
      {
        success: true,
        address: '1Zero',
        voidAddress: 'bitcoincashii:qzero',
        balance: 0,
      },
    ];

    const scan = buildScanResult(claims);
    expect(scan.totalBalance).toBe(100_000);
    expect(scan.claims).toHaveLength(1);
    expect(scan.claims[0].address).toBe('1Good');
  });

  it('getAntiGamingStatus returns no warning when postForkBalance is 0', () => {
    const scan: AirdropScanResult = {
      totalBalance: 100_000,
      airdropBalance: 100_000,
      postForkBalance: 0,
      claims: [],
    };

    const result = getAntiGamingStatus(scan);
    expect(result.warning).toBeNull();
    expect(result.blocked).toBe(false);
  });

  it('getAntiGamingStatus returns warning when excess VOID detected', () => {
    const scan: AirdropScanResult = {
      totalBalance: 150_000,
      airdropBalance: 100_000,
      postForkBalance: 50_000,
      claims: [],
    };

    const result = getAntiGamingStatus(scan);
    expect(result.warning).toContain('exceeds the current VOID balance');
    expect(result.blocked).toBe(false);
  });

  it('getAntiGamingStatus warns but does not block when no VOID match', () => {
    const scan: AirdropScanResult = {
      totalBalance: 50_000,
      airdropBalance: 0,
      postForkBalance: 50_000,
      claims: [],
    };

    const result = getAntiGamingStatus(scan);
    expect(result.warning).toContain('No matching VOID balance');
    expect(result.blocked).toBe(false);
  });
});

// ============================================================================
// 6. Cross-Component Integration
// ============================================================================
describe('Cross-component integration', () => {
  it('wallet storage address matches transaction builder derivation', async () => {
    // The address saved by saveWallet should match what sendTransaction derives
    const wallet = await saveWallet('Derivation Match', TEST_MNEMONIC, 'void');
    expect(wallet.address).toBe(SENDER_CASHADDR);
  });

  it('decodeCashAddr correctly round-trips addresses derived from walletStorage', async () => {
    const wallet = await saveWallet('Roundtrip', TEST_MNEMONIC, 'void');

    // decodeCashAddr should extract the 20-byte pubkey hash
    const decoded = decodeCashAddr(wallet.address, true);
    expect(decoded.type).toBe(0); // P2PKH
    expect(decoded.hash.length).toBe(20);

    // Re-encode and compare
    const reencoded = encodeCashAddr(decoded.hash, decoded.type);
    expect(reencoded).toBe(wallet.address);
  });

  it('send+store lifecycle', async () => {
    // Create wallet
    const wallet = await saveWallet('Auth Wallet', TEST_MNEMONIC, 'void');

    // Retrieve mnemonic
    const mnemonic = await getWalletMnemonic(wallet.id);
    expect(mnemonic).toBe(TEST_MNEMONIC);

    // Non-existent wallet returns null
    const noMnemonic = await getWalletMnemonic('nonexistent');
    expect(noMnemonic).toBeNull();

    // Send using retrieved mnemonic
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(50), vout: 0, value: 500_000 }]);
    const result = await sendTransaction(mnemonic!, DEST_CASHADDR, 100_000, 1, false);
    expect(result.txid).toBeTruthy();
  });

  it('fee rate too high (>1000 sat/byte) is rejected', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(51), vout: 0, value: 100_000 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1001, false),
    ).rejects.toThrow(/Fee rate too high/);
  });

  it('fee rate of exactly 1000 sat/byte is accepted', async () => {
    // 1 input, 2 outputs: 226 bytes * 1000 = 226_000 fee
    // Need at least 50_000 + 226_000 = 276_000
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(52), vout: 0, value: 500_000 }]);
    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1000, false);
    expect(result.hex).toBeTruthy();
  });

  it('broadcast failure propagates error to caller', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(53), vout: 0, value: 100_000 }]);
    mockBroadcastTransaction.mockRejectedValueOnce(new Error('Network error: connection refused'));

    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false),
    ).rejects.toThrow(/Network error/);
  });

  it('transaction hex has correct structure (version 2, valid varint)', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(54), vout: 0, value: 100_000 }]);
    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    // Version is 2
    expect(txBuf.readUInt32LE(0)).toBe(2);
    // Input count is 1
    expect(txBuf[4]).toBe(1);
    // Locktime is 0 (last 4 bytes)
    expect(txBuf.readUInt32LE(txBuf.length - 4)).toBe(0);
  });
});
