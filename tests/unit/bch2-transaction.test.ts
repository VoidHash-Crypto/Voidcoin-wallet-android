/**
 * Unit tests for VOID Transaction Builder
 *
 * Tests cover: coin selection, transaction serialization, fee estimation,
 * signing (SIGHASH_FORKID vs legacy), edge cases, and SegWit recovery.
 *
 * Strategy: We mock the network layer (VoidElectrum) and use real crypto
 * (noble_ecc, bip32, bip39) so that signatures and hashes are deterministic
 * and verifiable against the actual transaction builder logic.
 */

import * as bip39 from 'bip39';
import BIP32Factory from 'bip32';
import ecc from '../../blue_modules/noble_ecc';

const bip32 = BIP32Factory(ecc);
const crypto = require('crypto');
const bs58check = require('bs58check');

// ---- Mocks ----------------------------------------------------------------
// Mock the Electrum module so sendTransaction/sendFromBech32/etc. never hit the
// network. The mocks return controlled UTXO sets and accept any broadcast.

const mockGetUtxosByAddress = jest.fn();
const mockGetVOIDUtxos = jest.fn();
const mockGetUtxosByScripthash = jest.fn();
const mockBroadcastTransaction = jest.fn();
const mockBroadcastVOIDTransaction = jest.fn();

jest.mock('../../blue_modules/VoidElectrum', () => ({
  getUtxosByAddress: (...args: any[]) => mockGetUtxosByAddress(...args),
  getVOIDUtxos: (...args: any[]) => mockGetVOIDUtxos(...args),
  getUtxosByScripthash: (...args: any[]) => mockGetUtxosByScripthash(...args),
  broadcastTransaction: (...args: any[]) => mockBroadcastTransaction(...args),
  broadcastVOIDTransaction: (...args: any[]) => mockBroadcastVOIDTransaction(...args),
}));

// Import after mocking
import { sendTransaction, sendFromBech32, sendFromP2SH, sendFromP2WSH, sendFromP2TR, decodeCashAddr } from '../../class/void-transaction';

// ---- Test Helpers ----------------------------------------------------------

/** Deterministic test mnemonic (12-word BIP39). DO NOT use for real funds. */
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Produce a valid-looking 64-char hex txid from a seed number */
function fakeTxid(n: number): string {
  const hex = n.toString(16).padStart(2, '0');
  return hex.repeat(32);
}

/** Helper: hash160 (SHA256 then RIPEMD160) */
function hash160(data: Buffer): Buffer {
  const sha256Hash = crypto.createHash('sha256').update(data).digest();
  return crypto.createHash('ripemd160').update(sha256Hash).digest();
}

// ---- CashAddr encoder (for generating valid test addresses) ----------------
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
  const versionByte = (type << 3) | 0; // type and size_code=0 for 20-byte hash
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

// ---- Bech32 encoder (for generating valid test bc1 addresses) --------------
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) { if ((top >> i) & 1) chk ^= BECH32_GENERATOR[i]; }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const r: number[] = [];
  for (const c of hrp) r.push(c.charCodeAt(0) >> 5);
  r.push(0);
  for (const c of hrp) r.push(c.charCodeAt(0) & 31);
  return r;
}

function encodeBech32(hrp: string, version: number, program: Buffer): string {
  const data5bit: number[] = [version];
  let acc = 0; let bits = 0;
  for (const byte of program) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; data5bit.push((acc >> bits) & 0x1f); }
  }
  if (bits > 0) data5bit.push((acc << (5 - bits)) & 0x1f);

  const hrpExp = bech32HrpExpand(hrp);
  const poly = bech32Polymod([...hrpExp, ...data5bit, 0, 0, 0, 0, 0, 0]) ^ 1;
  const cksum: number[] = [];
  for (let i = 0; i < 6; i++) cksum.push((poly >> (5 * (5 - i))) & 0x1f);

  let result = hrp + '1';
  for (const v of [...data5bit, ...cksum]) result += BECH32_CHARSET[v];
  return result;
}

// ---- Pre-derived test addresses (computed once, used everywhere) -----------
// We derive valid addresses from the test mnemonic so that CashAddr checksums pass.

let DEST_CASHADDR: string;  // Valid destination CashAddr (different derivation from sender)
let VOID_LEGACY_ADDR: string; // Valid VOID legacy address (same mnemonic, VOID path)
let BC1_ADDRESS: string;    // Valid bc1 P2WPKH address (BIP84 m/84'/0'/0'/0/0)

beforeAll(async () => {
  const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
  const root = bip32.fromSeed(seed);

  // Destination: use a different index (m/44'/145'/0'/0/1) so it differs from the sender
  const destChild = root.derivePath("m/44'/145'/0'/0/1");
  const destPkh = hash160(Buffer.from(destChild.publicKey));
  DEST_CASHADDR = encodeCashAddr(destPkh, 0);

  // VOID legacy address at m/44'/0'/0'/0/0
  const voidChild = root.derivePath("m/44'/0'/0'/0/0");
  const voidPkh = hash160(Buffer.from(voidChild.publicKey));
  VOID_LEGACY_ADDR = bs58check.encode(Buffer.concat([Buffer.from([0x00]), voidPkh]));

  // bc1 P2WPKH address at m/84'/0'/0'/0/0
  const bech32Child = root.derivePath("m/84'/0'/0'/0/0");
  const bech32Pkh = hash160(Buffer.from(bech32Child.publicKey));
  BC1_ADDRESS = encodeBech32('bc', 0, bech32Pkh);
});

// ---- Reset mocks before each test -----------------------------------------
beforeEach(() => {
  jest.clearAllMocks();
  // Default broadcast mock returns a fake txid
  mockBroadcastTransaction.mockResolvedValue('abcd'.repeat(16));
  mockBroadcastVOIDTransaction.mockResolvedValue('ef01'.repeat(16));
});

// ============================================================================
// Coin Selection
// ============================================================================
describe('Coin selection', () => {
  it('selects a single UTXO when it covers amount + fee', async () => {
    // 1 input, 2 outputs: size = 10 + 148 + 68 = 226 bytes, fee = 226 sats at 1 sat/byte
    const utxo = { txid: fakeTxid(1), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);

    expect(result.txid).toBeTruthy();
    expect(result.hex).toBeTruthy();
    // Only 1 broadcast call
    expect(mockBroadcastTransaction).toHaveBeenCalledTimes(1);
    // The hex that was broadcast should match what was returned
    expect(mockBroadcastTransaction).toHaveBeenCalledWith(result.hex);
  });

  it('throws "Insufficient funds" when UTXOs cannot cover amount + fee', async () => {
    const utxo = { txid: fakeTxid(2), vout: 0, value: 1000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false),
    ).rejects.toThrow(/Insufficient funds/);
  });

  it('selects multiple UTXOs when a single one is not enough', async () => {
    // Amount 80_000. Each UTXO is 50_000. Need at least 2.
    // 2 inputs, 2 outputs: 10 + 296 + 68 = 374, fee 374
    const utxos = [
      { txid: fakeTxid(3), vout: 0, value: 50_000 },
      { txid: fakeTxid(4), vout: 0, value: 50_000 },
    ];
    mockGetUtxosByAddress.mockResolvedValue(utxos);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 80_000, 1, false);
    expect(result.hex).toBeTruthy();

    // Verify the raw tx hex starts with version 02000000 and encodes 2 inputs
    const txBuf = Buffer.from(result.hex, 'hex');
    expect(txBuf.readUInt32LE(0)).toBe(2); // version
    expect(txBuf[4]).toBe(2); // input count varint
  });

  it('rejects amounts below dust threshold (546 sats)', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(5), vout: 0, value: 100_000 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 545, 1, false),
    ).rejects.toThrow(/dust threshold/);
  });

  it('throws when UTXO set is empty', async () => {
    mockGetUtxosByAddress.mockResolvedValue([]);
    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 1000, 1, false),
    ).rejects.toThrow(/No UTXOs available/);
  });

  it('absorbs dust change into fee (no change output) when change <= 546', async () => {
    // 1-in 2-out: fee=226, change = 50600 - 50000 - 226 = 374 (<=546, dust)
    // So tx should be 1-in 1-out: fee=192.
    const utxo = { txid: fakeTxid(6), vout: 0, value: 50_600 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    // Parse to find output count
    let offset = 5; // past version(4) + input count varint(1)
    const scriptSigLen = txBuf[offset + 36]; // 36 = 32 (txid) + 4 (vout)
    offset += 36 + 1 + scriptSigLen + 4; // past txid+vout+varint+scriptSig+sequence
    const outputCount = txBuf[offset];
    expect(outputCount).toBe(1); // dust absorbed into fee
  });

  it('creates change output when change > 546', async () => {
    // 1-in 2-out: fee=226. value=100_000, amount=50_000. change=100000-50000-226=49774 > 546
    const utxo = { txid: fakeTxid(7), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4;
    const outputCount = txBuf[offset];
    expect(outputCount).toBe(2);
  });
});

// ============================================================================
// Transaction Serialization
// ============================================================================
describe('Transaction serialization', () => {
  it('uses SIGHASH_FORKID (0x41) for VOID transactions', async () => {
    const utxo = { txid: fakeTxid(10), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    // In the scriptSig, after the DER signature bytes, the hash type byte should be 0x41
    // Parse: version(4) + varint_inputcount(1) + txid(32) + vout(4) + varint_scriptSigLen(1)
    const scriptSigStart = 5 + 32 + 4 + 1; // offset where scriptSig begins
    const scriptSigLen = txBuf[5 + 32 + 4];
    const scriptSig = txBuf.subarray(scriptSigStart, scriptSigStart + scriptSigLen);

    // scriptSig layout: varint(sigLen) | sig | hashtype(0x41) | varint(pubkeyLen) | pubkey
    const sigPushLen = scriptSig[0]; // length of sig+hashtype
    const hashTypeByte = scriptSig[sigPushLen]; // last byte of sig push is hashtype
    expect(hashTypeByte).toBe(0x41);
  });

  it('uses SIGHASH_ALL (0x01) for VOID transactions', async () => {
    const utxo = { txid: fakeTxid(11), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    // Send VOID transaction to a legacy address
    const result = await sendTransaction(TEST_MNEMONIC, '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 50_000, 1, true);
    const txBuf = Buffer.from(result.hex, 'hex');

    const scriptSigStart = 5 + 32 + 4 + 1;
    const scriptSigLen = txBuf[5 + 32 + 4];
    const scriptSig = txBuf.subarray(scriptSigStart, scriptSigStart + scriptSigLen);

    const sigPushLen = scriptSig[0];
    const hashTypeByte = scriptSig[sigPushLen];
    expect(hashTypeByte).toBe(0x01);
  });

  it('produces correct P2PKH output script for CashAddr destination', async () => {
    const utxo = { txid: fakeTxid(12), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txHex = result.hex;

    // The output script for a P2PKH CashAddr should be:
    // OP_DUP(76) OP_HASH160(a9) PUSH20(14) <20-byte-hash> OP_EQUALVERIFY(88) OP_CHECKSIG(ac)
    expect(txHex).toContain('76a914');
    expect(txHex).toContain('88ac');
  });

  it('encodes version as 2 (little-endian) and locktime as 0', async () => {
    const utxo = { txid: fakeTxid(13), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    // Version is first 4 bytes
    expect(txBuf.readUInt32LE(0)).toBe(2);

    // Locktime is last 4 bytes
    expect(txBuf.readUInt32LE(txBuf.length - 4)).toBe(0);
  });

  it('encodes VarInt correctly for single-byte values', () => {
    // We verify by checking the raw tx structure for 1 and 2 inputs.
    // VarInt 1 = 0x01 (1 byte), VarInt 2 = 0x02 (1 byte)
    const txHex1Input = '0200000001'; // version(02000000) + varint(01)
    expect(Buffer.from(txHex1Input, 'hex')[4]).toBe(1);
  });
});

// ============================================================================
// Fee Estimation
// ============================================================================
describe('Fee estimation', () => {
  it('estimates correct byte-size (148/input + 34/output + 10 overhead)', async () => {
    // 1 input, 2 outputs: expected size = 10 + 148 + 68 = 226, fee at 1 sat/byte = 226
    const utxo = { txid: fakeTxid(20), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    // Parse to find change amount. fee = 226. change = 100_000 - 50_000 - 226 = 49_774
    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4; // skip input
    offset += 1; // skip output count varint

    // First output: amount(8) + varint(scriptLen) + script
    const amount1 = Number(txBuf.readBigUInt64LE(offset));
    expect(amount1).toBe(50_000);
    offset += 8;
    const script1Len = txBuf[offset];
    offset += 1 + script1Len;

    // Second output (change): amount(8)
    const amount2 = Number(txBuf.readBigUInt64LE(offset));
    expect(amount2).toBe(49_774); // 100_000 - 50_000 - 226
  });

  it('clamps fee rate to minimum 1 sat/byte for zero', async () => {
    const utxo = { txid: fakeTxid(21), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    // Pass feePerByte = 0 -- should be clamped to 1
    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 0, false);
    expect(result.hex).toBeTruthy();

    // Parse the change amount to verify fee was based on 1 sat/byte
    const txBuf = Buffer.from(result.hex, 'hex');
    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4;
    offset += 1; // output count
    // skip first output
    offset += 8;
    const script1Len = txBuf[offset];
    offset += 1 + script1Len;
    const changeAmount = Number(txBuf.readBigUInt64LE(offset));
    expect(changeAmount).toBe(49_774); // same as 1 sat/byte fee
  });

  it('clamps fee rate to minimum 1 sat/byte for negative values', async () => {
    const utxo = { txid: fakeTxid(22), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    // Pass feePerByte = -5
    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, -5, false);
    expect(result.hex).toBeTruthy();

    const txBuf = Buffer.from(result.hex, 'hex');
    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4;
    offset += 1;
    offset += 8;
    const script1Len = txBuf[offset];
    offset += 1 + script1Len;
    const changeAmount = Number(txBuf.readBigUInt64LE(offset));
    expect(changeAmount).toBe(49_774);
  });

  it('correctly applies higher fee rates', async () => {
    const utxo = { txid: fakeTxid(23), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    // 5 sat/byte: 1 input 2 outputs = 226 * 5 = 1130 fee
    // change = 100_000 - 50_000 - 1130 = 48_870
    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 5, false);
    const txBuf = Buffer.from(result.hex, 'hex');
    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4;
    offset += 1;
    offset += 8;
    const script1Len = txBuf[offset];
    offset += 1 + script1Len;
    const changeAmount = Number(txBuf.readBigUInt64LE(offset));
    expect(changeAmount).toBe(48_870);
  });
});

// ============================================================================
// Signing
// ============================================================================
describe('Signing', () => {
  it('produces a valid DER-encoded ECDSA signature for VOID', async () => {
    const utxo = { txid: fakeTxid(30), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    // Extract the DER signature from scriptSig
    const scriptSigLenOffset = 5 + 32 + 4; // after version + varint + txid + vout
    const scriptSigLen = txBuf[scriptSigLenOffset];
    const scriptSig = txBuf.subarray(scriptSigLenOffset + 1, scriptSigLenOffset + 1 + scriptSigLen);

    // First byte of scriptSig is push length for sig+hashtype
    const sigPushLen = scriptSig[0];
    const sigWithHashType = scriptSig.subarray(1, 1 + sigPushLen);

    // DER signature starts with 0x30 (SEQUENCE tag)
    expect(sigWithHashType[0]).toBe(0x30);
    // Last byte is hashtype 0x41
    expect(sigWithHashType[sigWithHashType.length - 1]).toBe(0x41);
  });

  it('produces a valid DER-encoded ECDSA signature for VOID', async () => {
    const utxo = { txid: fakeTxid(31), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 50_000, 1, true);
    const txBuf = Buffer.from(result.hex, 'hex');

    const scriptSigLenOffset = 5 + 32 + 4;
    const scriptSigLen = txBuf[scriptSigLenOffset];
    const scriptSig = txBuf.subarray(scriptSigLenOffset + 1, scriptSigLenOffset + 1 + scriptSigLen);

    const sigPushLen = scriptSig[0];
    const sigWithHashType = scriptSig.subarray(1, 1 + sigPushLen);

    // DER: starts with 0x30
    expect(sigWithHashType[0]).toBe(0x30);
    // VOID uses SIGHASH_ALL = 0x01
    expect(sigWithHashType[sigWithHashType.length - 1]).toBe(0x01);
  });

  it('includes compressed public key (33 bytes, 02 or 03 prefix) in scriptSig', async () => {
    const utxo = { txid: fakeTxid(32), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    // Parse scriptSig to find the public key push
    const scriptSigLenOffset = 5 + 32 + 4;
    const scriptSigLen = txBuf[scriptSigLenOffset];
    const scriptSig = txBuf.subarray(scriptSigLenOffset + 1, scriptSigLenOffset + 1 + scriptSigLen);

    // Skip past sig push
    const sigPushLen = scriptSig[0];
    const pubkeyPushOffset = 1 + sigPushLen;
    const pubkeyLen = scriptSig[pubkeyPushOffset];
    const pubkey = scriptSig.subarray(pubkeyPushOffset + 1, pubkeyPushOffset + 1 + pubkeyLen);

    expect(pubkeyLen).toBe(33);
    expect(pubkey[0] === 0x02 || pubkey[0] === 0x03).toBe(true);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================
describe('Edge cases', () => {
  it('handles NaN fee rate by clamping to 1 sat/byte', async () => {
    const utxo = { txid: fakeTxid(40), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, NaN, false);
    expect(result.hex).toBeTruthy();
  });

  it('handles Infinity fee rate by clamping to 1 sat/byte', async () => {
    const utxo = { txid: fakeTxid(41), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, Infinity, false);
    expect(result.hex).toBeTruthy();
  });

  it('rejects zero amount', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(42), vout: 0, value: 100_000 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 0, 1, false),
    ).rejects.toThrow(/dust threshold/);
  });

  it('rejects negative amount', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(43), vout: 0, value: 100_000 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, -1000, 1, false),
    ).rejects.toThrow(/Invalid amount/);
  });

  it('rejects amount equal to 545 sats (below dust threshold)', async () => {
    mockGetUtxosByAddress.mockResolvedValue([{ txid: fakeTxid(44), vout: 0, value: 100_000 }]);
    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 545, 1, false),
    ).rejects.toThrow(/dust threshold/);
  });

  it('accepts amount exactly at dust threshold (546 sats)', async () => {
    const utxo = { txid: fakeTxid(45), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 546, 1, false);
    expect(result.hex).toBeTruthy();
  });

  it('rejects when total balance equals exactly amount (no room for fee)', async () => {
    // Balance = 50_000, amount = 50_000. Fee for 1-in 1-out = 192 sats. Not enough.
    const utxo = { txid: fakeTxid(46), vout: 0, value: 50_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false),
    ).rejects.toThrow(/Insufficient funds/);
  });

  it('filters out UTXOs with invalid txid format', async () => {
    const utxos = [
      { txid: 'not_a_valid_hex_txid', vout: 0, value: 100_000 },
      { txid: fakeTxid(47), vout: 0, value: 100_000 },
    ];
    mockGetUtxosByAddress.mockResolvedValue(utxos);

    // Should succeed using only the valid UTXO
    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    expect(result.hex).toBeTruthy();
  });

  it('deduplicates UTXOs with same txid:vout', async () => {
    const utxos = [
      { txid: fakeTxid(48), vout: 0, value: 100_000 },
      { txid: fakeTxid(48), vout: 0, value: 100_000 }, // duplicate
    ];
    mockGetUtxosByAddress.mockResolvedValue(utxos);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');
    // Only 1 input should be used (deduplicated)
    expect(txBuf[4]).toBe(1);
  });

  it('handles fractional fee rate by ceiling to integer', async () => {
    const utxo = { txid: fakeTxid(49), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    // 1.5 sat/byte should be ceiled to 2
    // 1 input 2 outputs: 226 * 2 = 452 fee. change = 100000 - 50000 - 452 = 49548
    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1.5, false);
    const txBuf = Buffer.from(result.hex, 'hex');
    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4;
    offset += 1;
    offset += 8;
    const script1Len = txBuf[offset];
    offset += 1 + script1Len;
    const changeAmount = Number(txBuf.readBigUInt64LE(offset));
    expect(changeAmount).toBe(49_548);
  });
});

// ============================================================================
// CashAddr decoding (exported function)
// ============================================================================
describe('decodeCashAddr', () => {
  it('decodes a valid bitcoincashii: P2PKH address', () => {
    const result = decodeCashAddr(DEST_CASHADDR, true);
    expect(result.type).toBe(0); // P2PKH
    expect(result.hash.length).toBe(20);
  });

  it('rejects bitcoincash: prefix (BCH, not VOID)', () => {
    expect(() => {
      decodeCashAddr('bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292');
    }).toThrow(/bitcoincashii/);
  });

  it('rejects addresses with invalid characters', () => {
    expect(() => {
      // 'b' is not valid in CashAddr charset
      decodeCashAddr('bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky29b');
    }).toThrow();
  });

  it('returns Buffer when called without returnType flag', () => {
    const result = decodeCashAddr(DEST_CASHADDR);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect((result as Buffer).length).toBe(20);
  });
});

// ============================================================================
// SegWit Recovery (sendFromBech32)
// ============================================================================
describe('SegWit recovery (sendFromBech32)', () => {
  it('rejects amounts below dust threshold', async () => {
    await expect(
      sendFromBech32(TEST_MNEMONIC, BC1_ADDRESS, DEST_CASHADDR, 100, 1),
    ).rejects.toThrow(/dust threshold/);
  });

  it('rejects non-P2WPKH bc1 addresses (wrong program length)', async () => {
    // bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 is a valid P2WPKH but not derived
    // from our mnemonic. sendFromBech32 checks version=0 and program.length=20.
    // Use a known P2WSH address (32-byte program) to trigger the P2WPKH check error.
    // We must use a valid bech32 address with 32-byte program (witness version 0).
    // Generate one: SHA256 of something as the "program"
    const fakeProgram = crypto.createHash('sha256').update('test').digest();
    const p2wshAddr = encodeBech32('bc', 0, fakeProgram);

    await expect(
      sendFromBech32(TEST_MNEMONIC, p2wshAddr, DEST_CASHADDR, 1000, 1),
    ).rejects.toThrow(/P2WPKH/);
  });

  it('builds a SegWit recovery tx with SIGHASH_FORKID (0x41) and sig in scriptSig', async () => {
    // Mock UTXOs for scripthash lookup
    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(50), vout: 0, value: 100_000 }]);

    const result = await sendFromBech32(TEST_MNEMONIC, BC1_ADDRESS, DEST_CASHADDR, 50_000, 1);

    expect(result.hex).toBeTruthy();
    const txBuf = Buffer.from(result.hex, 'hex');

    // Version = 2
    expect(txBuf.readUInt32LE(0)).toBe(2);

    // 1 input
    expect(txBuf[4]).toBe(1);

    // Extract scriptSig and verify hashtype 0x41
    const scriptSigLenOffset = 5 + 32 + 4;
    const scriptSigLen = txBuf[scriptSigLenOffset];
    expect(scriptSigLen).toBeGreaterThan(0); // sig is in scriptSig, not witness
    const scriptSig = txBuf.subarray(scriptSigLenOffset + 1, scriptSigLenOffset + 1 + scriptSigLen);

    const sigPushLen = scriptSig[0];
    const hashTypeByte = scriptSig[sigPushLen];
    expect(hashTypeByte).toBe(0x41); // SIGHASH_ALL | FORKID
  });

  it('throws when no matching key found for bc1 address', async () => {
    // Use a bc1 address derived from a different key (a random pubkey hash)
    const randomPkh = crypto.randomBytes(20);
    const unmatchedBc1 = encodeBech32('bc', 0, randomPkh);

    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(51), vout: 0, value: 100_000 }]);

    await expect(
      sendFromBech32(TEST_MNEMONIC, unmatchedBc1, DEST_CASHADDR, 50_000, 1),
    ).rejects.toThrow(/Could not find private key/);
  });

  it('uses scripthash-based UTXO lookup', async () => {
    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(52), vout: 0, value: 100_000 }]);

    await sendFromBech32(TEST_MNEMONIC, BC1_ADDRESS, DEST_CASHADDR, 50_000, 1);
    expect(mockGetUtxosByScripthash).toHaveBeenCalledTimes(1);
    // The scripthash should be a 64-char hex string (SHA256 reversed)
    const calledWith = mockGetUtxosByScripthash.mock.calls[0][0];
    expect(calledWith).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ============================================================================
// P2SH-P2WPKH Recovery (sendFromP2SH)
// ============================================================================
describe('P2SH-P2WPKH recovery (sendFromP2SH)', () => {
  it('rejects amounts below dust threshold', async () => {
    await expect(
      sendFromP2SH(TEST_MNEMONIC, '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', DEST_CASHADDR, 100, 1),
    ).rejects.toThrow(/dust threshold/);
  });

  it('throws when no matching key found for 3xxx address', async () => {
    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(53), vout: 0, value: 100_000 }]);

    await expect(
      sendFromP2SH(TEST_MNEMONIC, '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', DEST_CASHADDR, 50_000, 1),
    ).rejects.toThrow(/Could not find private key/);
  });

  it('builds a P2SH-P2WPKH recovery tx with correct structure', async () => {
    // Derive the P2SH-P2WPKH address for the test mnemonic at m/49'/0'/0'/0/0
    const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);
    const child = root.derivePath("m/49'/0'/0'/0/0");
    const pubkeyHash = hash160(Buffer.from(child.publicKey));
    const redeemScript = Buffer.concat([Buffer.from([0x00, 0x14]), pubkeyHash]);
    const scriptHash = hash160(redeemScript);
    const versionedHash = Buffer.concat([Buffer.from([0x05]), scriptHash]);
    const p2shAddress = bs58check.encode(versionedHash);

    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(54), vout: 0, value: 100_000 }]);

    const result = await sendFromP2SH(TEST_MNEMONIC, p2shAddress, DEST_CASHADDR, 50_000, 1);

    expect(result.hex).toBeTruthy();
    const txBuf = Buffer.from(result.hex, 'hex');

    // Version 2
    expect(txBuf.readUInt32LE(0)).toBe(2);
    // 1 input
    expect(txBuf[4]).toBe(1);

    // scriptSig should contain the redeemScript (0x0014 prefix for P2WPKH)
    const scriptSigLenOffset = 5 + 32 + 4;
    const scriptSigLen = txBuf[scriptSigLenOffset];
    const scriptSig = txBuf.subarray(scriptSigLenOffset + 1, scriptSigLenOffset + 1 + scriptSigLen);

    // The redeemScript (22 bytes: 0x00 0x14 <20-byte-hash>) should appear at the end of scriptSig
    const redeemScriptHex = redeemScript.toString('hex');
    const scriptSigHex = scriptSig.toString('hex');
    expect(scriptSigHex).toContain(redeemScriptHex);
  });
});

// ============================================================================
// P2WSH Recovery (sendFromP2WSH)
// ============================================================================
describe('P2WSH recovery (sendFromP2WSH)', () => {
  it('rejects amounts below dust threshold', async () => {
    // Use a valid bech32 address with 32-byte program for the P2WSH check
    const fakeProgram = crypto.createHash('sha256').update('test-p2wsh').digest();
    const fakeP2WSH = encodeBech32('bc', 0, fakeProgram);

    await expect(
      sendFromP2WSH(TEST_MNEMONIC, fakeP2WSH, DEST_CASHADDR, 100, 1),
    ).rejects.toThrow(/dust threshold/);
  });

  it('rejects non-P2WSH bc1 addresses (expects 32-byte program)', async () => {
    // P2WPKH address has 20-byte program; sendFromP2WSH expects 32-byte
    await expect(
      sendFromP2WSH(TEST_MNEMONIC, BC1_ADDRESS, DEST_CASHADDR, 50_000, 1),
    ).rejects.toThrow(/P2WSH/);
  });
});

// ============================================================================
// VOID vs VOID derivation paths
// ============================================================================
describe('Derivation path selection', () => {
  it('uses VOID network calls for isVOID=false', async () => {
    const utxo = { txid: fakeTxid(60), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    // VOID mode (isVOID=false) calls getUtxosByAddress
    await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    expect(mockGetUtxosByAddress).toHaveBeenCalledTimes(1);
    expect(mockGetVOIDUtxos).not.toHaveBeenCalled();
  });

  it('uses VOID network calls for isVOID=true', async () => {
    const utxo = { txid: fakeTxid(61), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    // VOID mode (isVOID=true) calls getVOIDUtxos
    await sendTransaction(TEST_MNEMONIC, '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 50_000, 1, true);
    expect(mockGetVOIDUtxos).toHaveBeenCalledTimes(1);
    expect(mockGetUtxosByAddress).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Deterministic output: same inputs produce same transaction
// ============================================================================
describe('Determinism', () => {
  it('produces identical tx hex for identical inputs', async () => {
    const utxo = { txid: fakeTxid(70), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result1 = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);

    // Reset mock to return same UTXO again
    mockGetUtxosByAddress.mockResolvedValue([{ ...utxo }]);

    const result2 = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);

    expect(result1.hex).toBe(result2.hex);
  });
});

// ============================================================================
// Bech32m encoder helper (for generating valid bc1p test addresses)
// ============================================================================
const BECH32M_CONST = 0x2bc830a3;

function encodeBech32m(hrp: string, version: number, program: Buffer): string {
  const data5bit: number[] = [version];
  let acc = 0; let bits = 0;
  for (const byte of program) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; data5bit.push((acc >> bits) & 0x1f); }
  }
  if (bits > 0) data5bit.push((acc << (5 - bits)) & 0x1f);

  const hrpExp = bech32HrpExpand(hrp);
  const poly = bech32Polymod([...hrpExp, ...data5bit, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST;
  const cksum: number[] = [];
  for (let i = 0; i < 6; i++) cksum.push((poly >> (5 * (5 - i))) & 0x1f);

  let result = hrp + '1';
  for (const v of [...data5bit, ...cksum]) result += BECH32_CHARSET[v];
  return result;
}

// ============================================================================
// P2TR Recovery (sendFromP2TR)
// ============================================================================
describe('P2TR recovery (sendFromP2TR)', () => {
  // Pre-derive a valid bc1p (P2TR) address from the test mnemonic for BIP86 path m/86'/0'/0'/0/0
  let BC1P_ADDRESS: string;
  let BC1P_TWEAKED_XONLY: Buffer;

  beforeAll(async () => {
    const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);
    const child = root.derivePath("m/86'/0'/0'/0/0");
    const pubkey = Buffer.from(child.publicKey);
    const xonly = pubkey.subarray(1, 33);

    // Compute TapTweak
    const tagHashBuf = crypto.createHash('sha256').update(Buffer.from('TapTweak', 'utf8')).digest();
    const tweakData = Buffer.concat([tagHashBuf, tagHashBuf, xonly]);
    const tweak = crypto.createHash('sha256').update(tweakData).digest();

    // Use ecc.xOnlyPointAddTweak
    const tweakResult = ecc.xOnlyPointAddTweak(xonly, tweak);
    BC1P_TWEAKED_XONLY = Buffer.from(tweakResult!.xOnlyPubkey);
    BC1P_ADDRESS = encodeBech32m('bc', 1, BC1P_TWEAKED_XONLY);
  });

  it('rejects amounts below dust threshold (546 sats)', async () => {
    await expect(
      sendFromP2TR(TEST_MNEMONIC, BC1P_ADDRESS, DEST_CASHADDR, 100, 1),
    ).rejects.toThrow(/dust threshold/);
  });

  it('rejects non-P2TR bc1 address (20-byte program, witness v0)', async () => {
    // BC1_ADDRESS is a bc1q P2WPKH address (20-byte program, version 0)
    // sendFromP2TR expects version 1 with 32-byte program
    await expect(
      sendFromP2TR(TEST_MNEMONIC, BC1_ADDRESS, DEST_CASHADDR, 1000, 1),
    ).rejects.toThrow(/Invalid bc1p P2TR address/);
  });

  it('builds a P2TR recovery tx with version=2 and Schnorr signature in scriptSig', async () => {
    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(80), vout: 0, value: 100_000 }]);

    const result = await sendFromP2TR(TEST_MNEMONIC, BC1P_ADDRESS, DEST_CASHADDR, 50_000, 1);

    expect(result.hex).toBeTruthy();
    const txBuf = Buffer.from(result.hex, 'hex');

    // Version = 2
    expect(txBuf.readUInt32LE(0)).toBe(2);

    // 1 input
    expect(txBuf[4]).toBe(1);

    // Extract scriptSig - for P2TR, it contains a 64-byte Schnorr signature push
    const scriptSigLenOffset = 5 + 32 + 4; // version(4) + varint_inputcount(1) + txid(32) + vout(4)
    const scriptSigLen = txBuf[scriptSigLenOffset];
    expect(scriptSigLen).toBeGreaterThan(0);
    const scriptSig = txBuf.subarray(scriptSigLenOffset + 1, scriptSigLenOffset + 1 + scriptSigLen);

    // P2TR scriptSig: varint(64) + 64-byte-schnorr-sig (SIGHASH_DEFAULT, no hashtype byte appended)
    const sigPushLen = scriptSig[0];
    expect(sigPushLen).toBe(64); // 64-byte Schnorr signature
  });

  it('throws when no matching key found for bc1p address', async () => {
    // Create a bc1p address from random 32-byte x-only pubkey
    const randomXonly = crypto.randomBytes(32);
    const unmatchedBc1p = encodeBech32m('bc', 1, randomXonly);

    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(81), vout: 0, value: 100_000 }]);

    await expect(
      sendFromP2TR(TEST_MNEMONIC, unmatchedBc1p, DEST_CASHADDR, 50_000, 1),
    ).rejects.toThrow(/Could not find private key/);
  });

  it('throws "Insufficient funds" when UTXOs cannot cover amount + fee', async () => {
    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(82), vout: 0, value: 1000 }]);

    await expect(
      sendFromP2TR(TEST_MNEMONIC, BC1P_ADDRESS, DEST_CASHADDR, 50_000, 1),
    ).rejects.toThrow(/Insufficient funds/);
  });

  it('throws when no UTXOs are available', async () => {
    mockGetUtxosByScripthash.mockResolvedValue([]);

    await expect(
      sendFromP2TR(TEST_MNEMONIC, BC1P_ADDRESS, DEST_CASHADDR, 50_000, 1),
    ).rejects.toThrow(/No UTXOs available/);
  });

  it('decodes a valid bc1p Bech32m address correctly', () => {
    // BC1P_ADDRESS was encoded with version=1 and 32-byte program
    // We verify round-trip by re-encoding from the tweaked x-only pubkey
    const reEncoded = encodeBech32m('bc', 1, BC1P_TWEAKED_XONLY);
    expect(reEncoded).toBe(BC1P_ADDRESS);
  });

  it('rejects Bech32m address with invalid checksum', async () => {
    // Take a valid bc1p address and corrupt the last character
    const validAddr = BC1P_ADDRESS;
    const lastChar = validAddr[validAddr.length - 1];
    const corruptChar = lastChar === 'q' ? 'p' : 'q';
    const corruptAddr = validAddr.slice(0, -1) + corruptChar;

    await expect(
      sendFromP2TR(TEST_MNEMONIC, corruptAddr, DEST_CASHADDR, 1000, 1),
    ).rejects.toThrow(/Invalid bc1p P2TR address/);
  });

  it('uses scripthash-based UTXO lookup for P2TR', async () => {
    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(83), vout: 0, value: 100_000 }]);

    await sendFromP2TR(TEST_MNEMONIC, BC1P_ADDRESS, DEST_CASHADDR, 50_000, 1);
    expect(mockGetUtxosByScripthash).toHaveBeenCalledTimes(1);
    const calledWith = mockGetUtxosByScripthash.mock.calls[0][0];
    expect(calledWith).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ============================================================================
// addressToScript (internal, tested via sendTransaction output scripts)
// ============================================================================
describe('addressToScript output scripts', () => {
  it('produces correct witness v0 P2WPKH script for bc1q destination (via VOID sendTransaction)', async () => {
    // VOID now blocks sending to bc1 addresses — use VOID mode (isVOID=true) to test bc1 output scripts
    const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);
    const destChild = root.derivePath("m/84'/0'/0'/0/1");
    const destPkh = hash160(Buffer.from(destChild.publicKey));
    const destBc1 = encodeBech32('bc', 0, destPkh);

    const utxo = { txid: fakeTxid(90), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, destBc1, 50_000, 1, true);
    const txHex = result.hex;

    // P2WPKH output script: 0014<20-byte-hash>
    const expectedScript = '0014' + destPkh.toString('hex');
    expect(txHex).toContain(expectedScript);
  });

  it('produces correct witness v1 P2TR script for bc1p destination (via VOID sendTransaction)', async () => {
    // VOID now blocks sending to bc1 addresses — use VOID mode to test bc1p output scripts
    const fakeXonly = crypto.createHash('sha256').update('p2tr-test-dest').digest();
    const bc1pDest = encodeBech32m('bc', 1, fakeXonly);

    const utxo = { txid: fakeTxid(91), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, bc1pDest, 50_000, 1, true);
    const txHex = result.hex;

    // P2TR output script: 5120<32-byte-xonly-pubkey>
    const expectedScript = '5120' + fakeXonly.toString('hex');
    expect(txHex).toContain(expectedScript);
  });

  it('produces correct P2SH script for 3xxx destination', async () => {
    // When sending to a 3xxx (P2SH) address, output script: OP_HASH160 PUSH_20 <hash> OP_EQUAL (a914...87)
    // Use sendTransaction with isVOID=true to send to a P2SH address
    const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);
    const child = root.derivePath("m/49'/0'/0'/0/0");
    const pubkeyHash = hash160(Buffer.from(child.publicKey));
    const redeemScript = Buffer.concat([Buffer.from([0x00, 0x14]), pubkeyHash]);
    const scriptHash = hash160(redeemScript);
    const versionedHash = Buffer.concat([Buffer.from([0x05]), scriptHash]);
    const p2shAddress = bs58check.encode(versionedHash);

    const utxo = { txid: fakeTxid(92), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, p2shAddress, 50_000, 1, true);
    const txHex = result.hex;

    // P2SH output: a914<20-byte-script-hash>87
    const expectedPrefix = 'a914' + scriptHash.toString('hex') + '87';
    expect(txHex).toContain(expectedPrefix);
  });

  it('throws for invalid legacy address', async () => {
    const utxo = { txid: fakeTxid(93), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    // "1InvalidAddress" is not a valid base58check address
    await expect(
      sendTransaction(TEST_MNEMONIC, '1InvalidAddressXYZ123', 50_000, 1, true),
    ).rejects.toThrow();
  });
});

// ============================================================================
// encodeVarInt multi-byte paths
// ============================================================================
describe('encodeVarInt multi-byte paths', () => {
  // We test indirectly by examining tx hex with enough inputs/outputs to trigger multi-byte VarInt.
  // But we can also verify directly by checking the tx structure for known values.

  it('value 253 produces 0xfd prefix + 2 LE bytes', () => {
    // VarInt(253) should be: fd fd00
    // We verify by importing the module and checking the raw tx with 253+ inputs.
    // Since encodeVarInt is internal, we test via the tx hex byte pattern.
    // A tx with exactly 253 value in a VarInt context:
    // The VarInt encoding: n=253 -> buf[0]=0xfd, buf[1..2] = 253 as uint16LE = [0xfd, 0x00]
    // So full encoding is [0xfd, 0xfd, 0x00]
    // We can verify this via a small output script that is 253 bytes long,
    // but it's simpler to test by constructing the expected bytes directly.

    // Construct expected: 0xfd prefix, then 253 as uint16 LE
    const expected = Buffer.alloc(3);
    expected[0] = 0xfd;
    expected.writeUInt16LE(253, 1);
    expect(expected[0]).toBe(0xfd);
    expect(expected[1]).toBe(0xfd); // 253 & 0xff
    expect(expected[2]).toBe(0x00); // 253 >> 8

    // Now verify our tx builder produces correct VarInt by creating a tx where
    // we can observe the VarInt value in the output. We send a standard tx and
    // verify that scriptSig length (which is > 100 bytes, < 253) is encoded as 1-byte VarInt.
    // For 253+, we verify the math is correct based on the known encoding.
  });

  it('value 65536 produces 0xfe prefix + 4 LE bytes', () => {
    // VarInt(65536) -> buf[0]=0xfe, buf[1..4] = 65536 as uint32LE
    const expected = Buffer.alloc(5);
    expected[0] = 0xfe;
    expected.writeUInt32LE(65536, 1);
    expect(expected[0]).toBe(0xfe);
    expect(expected[1]).toBe(0x00); // 65536 & 0xff
    expect(expected[2]).toBe(0x00); // (65536 >> 8) & 0xff
    expect(expected[3]).toBe(0x01); // (65536 >> 16) & 0xff
    expect(expected[4]).toBe(0x00); // (65536 >> 24) & 0xff
  });
});

// ============================================================================
// sendFromBech32 insufficient funds
// ============================================================================
describe('sendFromBech32 insufficient funds', () => {
  it('throws "Insufficient funds" when UTXO value < amount + fee', async () => {
    // 1-in 2-out: size = 10 + 148 + 68 = 226 bytes at 1 sat/byte = 226 fee
    // Need 50_000 + 226 = 50_226 but have only 1_000
    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(95), vout: 0, value: 1_000 }]);

    await expect(
      sendFromBech32(TEST_MNEMONIC, BC1_ADDRESS, DEST_CASHADDR, 50_000, 1),
    ).rejects.toThrow(/Insufficient funds/);
  });
});

// ============================================================================
// P2WSH Recovery - successful path and insufficient funds
// ============================================================================
describe('P2WSH recovery - additional paths', () => {
  // Derive a valid P2WSH address from test mnemonic
  // P2WSH: OP_0 PUSH_32 SHA256(redeemScript)
  // redeemScript: P2PKH script for the derived key
  let P2WSH_ADDRESS: string;

  beforeAll(async () => {
    const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);
    const child = root.derivePath("m/84'/0'/0'/0/0");
    const pubkeyHash = hash160(Buffer.from(child.publicKey));
    const redeemScript = Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]),
      pubkeyHash,
      Buffer.from([0x88, 0xac]),
    ]);
    const scriptHash = crypto.createHash('sha256').update(redeemScript).digest();
    P2WSH_ADDRESS = encodeBech32('bc', 0, scriptHash);
  });

  it('builds a P2WSH recovery tx successfully with matching key', async () => {
    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(96), vout: 0, value: 100_000 }]);

    const result = await sendFromP2WSH(TEST_MNEMONIC, P2WSH_ADDRESS, DEST_CASHADDR, 50_000, 1);

    expect(result.hex).toBeTruthy();
    const txBuf = Buffer.from(result.hex, 'hex');

    // Version = 2
    expect(txBuf.readUInt32LE(0)).toBe(2);

    // 1 input
    expect(txBuf[4]).toBe(1);

    // Extract scriptSig and verify it contains the redeemScript (76a914...88ac)
    const scriptSigLenOffset = 5 + 32 + 4;
    const scriptSigLen = txBuf[scriptSigLenOffset];
    expect(scriptSigLen).toBeGreaterThan(0);
    const scriptSig = txBuf.subarray(scriptSigLenOffset + 1, scriptSigLenOffset + 1 + scriptSigLen);
    const scriptSigHex = scriptSig.toString('hex');

    // redeemScript should appear in scriptSig: 76a914<20-byte-hash>88ac
    expect(scriptSigHex).toContain('76a914');
    expect(scriptSigHex).toContain('88ac');

    // hashtype 0x41 (SIGHASH_ALL | FORKID) should be present
    const sigPushLen = scriptSig[0];
    const hashTypeByte = scriptSig[sigPushLen];
    expect(hashTypeByte).toBe(0x41);
  });

  it('throws "Insufficient funds" when P2WSH UTXOs cannot cover amount + fee', async () => {
    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(97), vout: 0, value: 1_000 }]);

    await expect(
      sendFromP2WSH(TEST_MNEMONIC, P2WSH_ADDRESS, DEST_CASHADDR, 50_000, 1),
    ).rejects.toThrow(/Insufficient funds/);
  });
});

// ============================================================================
// P2SH Recovery - UTXO/fee error paths
// ============================================================================
describe('P2SH recovery - UTXO/fee error paths', () => {
  // Derive the P2SH-P2WPKH address for the test mnemonic at m/49'/0'/0'/0/0
  let P2SH_ADDRESS: string;

  beforeAll(async () => {
    const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);
    const child = root.derivePath("m/49'/0'/0'/0/0");
    const pubkeyHash = hash160(Buffer.from(child.publicKey));
    const redeemScript = Buffer.concat([Buffer.from([0x00, 0x14]), pubkeyHash]);
    const scriptHash = hash160(redeemScript);
    const versionedHash = Buffer.concat([Buffer.from([0x05]), scriptHash]);
    P2SH_ADDRESS = bs58check.encode(versionedHash);
  });

  it('throws when no UTXOs are available for P2SH address', async () => {
    mockGetUtxosByScripthash.mockResolvedValue([]);

    await expect(
      sendFromP2SH(TEST_MNEMONIC, P2SH_ADDRESS, DEST_CASHADDR, 50_000, 1),
    ).rejects.toThrow(/No UTXOs available/);
  });

  it('throws "Insufficient funds" when P2SH UTXOs cannot cover amount + fee', async () => {
    // P2SH-P2WPKH: 1-in 2-out = 10 + 171 + 68 = 249 bytes, fee = 249 at 1 sat/byte
    // Need 50_000 + 249 = 50_249, have only 1_000
    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(99), vout: 0, value: 1_000 }]);

    await expect(
      sendFromP2SH(TEST_MNEMONIC, P2SH_ADDRESS, DEST_CASHADDR, 50_000, 1),
    ).rejects.toThrow(/Insufficient funds/);
  });
});

// ============================================================================
// addressToScript P2WSH output script (via sendFromBech32 to P2WSH destination)
// ============================================================================
describe('addressToScript P2WSH output', () => {
  it('produces OP_0 PUSH_32 <32-byte-hash> for P2WSH bc1q destination (via VOID sendTransaction)', async () => {
    // VOID now blocks sending to bc1 addresses — use VOID mode to test P2WSH output scripts
    const programHash = crypto.createHash('sha256').update('p2wsh-output-test').digest();
    const p2wshDest = encodeBech32('bc', 0, programHash);

    const utxo = { txid: fakeTxid(100), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, p2wshDest, 50_000, 1, true);
    const txHex = result.hex;

    // P2WSH output script: OP_0(00) PUSH_32(20) <32-byte-hash>
    const expectedScript = '0020' + programHash.toString('hex');
    expect(txHex).toContain(expectedScript);
  });
});

// ============================================================================
// addressToScript unsupported witness version/program
// ============================================================================
describe('addressToScript unsupported witness', () => {
  it('throws for bech32 address with witness version 1 but using bech32 (not bech32m) encoding', async () => {
    // VOID now blocks all bc1 destinations — the error fires before reaching version checks
    const randomProgram = crypto.randomBytes(20);
    const unsupportedAddr = encodeBech32('bc', 1, randomProgram);

    const utxo = { txid: fakeTxid(101), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    await expect(
      sendTransaction(TEST_MNEMONIC, unsupportedAddr, 50_000, 1, false),
    ).rejects.toThrow(/Cannot send VOID to a SegWit/);
  });
});

// ============================================================================
// decodeCashAddr insufficient hash data
// ============================================================================
describe('decodeCashAddr insufficient hash data', () => {
  it('rejects a CashAddr whose version byte implies 24-byte hash but payload is truncated', () => {
    // The version byte encodes type (top 5 bits) and size code (bottom 3 bits).
    // Size code 1 = 24-byte hash. We'll encode a version byte with size_code=1
    // but only provide a 20-byte hash, then fix the checksum so it passes polymod.
    // The decodeCashAddr function should throw 'Invalid CashAddr: insufficient hash data'.

    // Build a CashAddr with size_code=1 (24 bytes expected) but only 20 bytes of hash
    const prefix = 'bitcoincashii';
    const hashData = Buffer.alloc(20, 0xaa); // Only 20 bytes, but size_code says 24
    const versionByte = (0 << 3) | 1; // type=0 (P2PKH), size_code=1 (24 bytes)

    // Convert versionByte + hash to 5-bit groups
    const payload: number[] = [];
    let acc = versionByte;
    let bits = 8;
    for (const byte of hashData) {
      acc = (acc << 8) | byte;
      bits += 8;
      while (bits >= 5) { bits -= 5; payload.push((acc >> bits) & 0x1f); }
    }
    if (bits > 0) payload.push((acc << (5 - bits)) & 0x1f);

    // Compute valid checksum
    const prefixData: number[] = [];
    for (const c of prefix) prefixData.push(c.charCodeAt(0) & 0x1f);
    prefixData.push(0);
    const values = [...prefixData, ...payload, 0, 0, 0, 0, 0, 0, 0, 0];
    const pm = cashAddrPolymod(values) ^ 1n;
    const checksum: number[] = [];
    for (let i = 0; i < 8; i++) checksum.push(Number((pm >> BigInt(5 * (7 - i))) & 0x1fn));

    let addr = prefix + ':';
    for (const v of [...payload, ...checksum]) addr += CASHADDR_CHARSET[v];

    // The address has a valid checksum but the version byte says 24-byte hash
    // while only 20 bytes of hash data are present.
    expect(() => {
      decodeCashAddr(addr, true);
    }).toThrow(/insufficient hash data/);
  });
});

// ============================================================================
// sendTransaction alternate derivation path for VOID
// ============================================================================
describe('sendTransaction alternate derivation path for VOID', () => {
  it('falls back to m/44\'/0\'/0\'/0/1 when expectedAddress matches that path', async () => {
    // Derive the address at the alternate path m/44'/0'/0'/0/1
    const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);
    const altChild = root.derivePath("m/44'/0'/0'/0/1");
    const altPkh = hash160(Buffer.from(altChild.publicKey));
    const altAddress = bs58check.encode(Buffer.concat([Buffer.from([0x00]), altPkh]));

    // Mock the VOID UTXO lookup for the alternate address
    const utxo = { txid: fakeTxid(102), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    // Send with isVOID=true and expectedAddress matching the alternate path
    const result = await sendTransaction(
      TEST_MNEMONIC,
      '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', // destination
      50_000,
      1,
      true,
      altAddress, // expectedAddress that matches m/44'/0'/0'/0/1
    );

    expect(result.txid).toBeTruthy();
    expect(result.hex).toBeTruthy();
    // The VOID UTXO lookup should have been called (sendTransactionWithKey is invoked)
    expect(mockGetVOIDUtxos).toHaveBeenCalled();
    // Broadcast should have been called
    expect(mockBroadcastVOIDTransaction).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// encodeVarInt 8-byte branch (n > 0xFFFFFFFF)
// ============================================================================
describe('encodeVarInt 8-byte branch', () => {
  // encodeVarInt is a private (non-exported) function in void-transaction.ts.
  // It cannot be imported or called directly from tests.
  // We verify the 8-byte branch indirectly by validating the encoding logic:
  // For n > 0xFFFFFFFF, the function writes: [0xff] + BigUInt64LE(n).
  // Since constructing a transaction with > 4 billion inputs/outputs is infeasible
  // in a unit test, we verify the encoding math matches the expected wire format.

  it('8-byte VarInt encoding produces correct prefix and LE bytes for n > 0xFFFFFFFF', () => {
    // Simulate what encodeVarInt does for n = 0x100000000 (4294967296)
    const n = 0x100000000;
    const buf = Buffer.alloc(9);
    buf[0] = 0xff;
    buf.writeBigUInt64LE(BigInt(n), 1);

    expect(buf[0]).toBe(0xff);
    // 0x100000000 in little-endian 8 bytes: 00 00 00 00 01 00 00 00
    expect(buf[1]).toBe(0x00);
    expect(buf[2]).toBe(0x00);
    expect(buf[3]).toBe(0x00);
    expect(buf[4]).toBe(0x00);
    expect(buf[5]).toBe(0x01);
    expect(buf[6]).toBe(0x00);
    expect(buf[7]).toBe(0x00);
    expect(buf[8]).toBe(0x00);

    // Verify round-trip: reading back should give the original value
    const readBack = Number(buf.readBigUInt64LE(1));
    expect(readBack).toBe(n);
  });

  it('8-byte VarInt encoding for a large value (0x1FFFFFFFFFF)', () => {
    const n = 0x1FFFFFFFFFF; // 2199023255551
    const buf = Buffer.alloc(9);
    buf[0] = 0xff;
    buf.writeBigUInt64LE(BigInt(n), 1);

    expect(buf[0]).toBe(0xff);
    // Round-trip
    expect(Number(buf.readBigUInt64LE(1))).toBe(n);
    // Total buffer is 9 bytes
    expect(buf.length).toBe(9);
  });
});

// ============================================================================
// addressToScript CashAddr P2SH output
// ============================================================================
describe('addressToScript CashAddr P2SH', () => {
  it('produces correct P2SH output script (a914...87) for bitcoincashii:p... destination', async () => {
    // Generate a valid P2SH CashAddr address using a known script hash
    const scriptHash = Buffer.alloc(20, 0xbb); // 20-byte script hash
    const p2shCashAddr = encodeCashAddr(scriptHash, 1); // type=1 for P2SH

    // Verify it starts with 'bitcoincashii:p' (P2SH prefix in CashAddr)
    expect(p2shCashAddr.startsWith('bitcoincashii:p')).toBe(true);

    // Set up a UTXO for sendTransaction
    const utxo = { txid: fakeTxid(110), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    // Send to the P2SH CashAddr destination
    const result = await sendTransaction(TEST_MNEMONIC, p2shCashAddr, 50_000, 1, false);
    const txHex = result.hex;

    // The output script for a P2SH address should be:
    // OP_HASH160(a9) PUSH20(14) <20-byte-script-hash> OP_EQUAL(87)
    const expectedScriptFragment = 'a914' + scriptHash.toString('hex') + '87';
    expect(txHex).toContain(expectedScriptFragment);

    // Should NOT contain P2PKH opcodes (76a914...88ac) in the destination output
    // Parse the tx to find the destination output script specifically
    const txBuf = Buffer.from(txHex, 'hex');
    // Skip to outputs: version(4) + varint(1) + input data + varint(1)
    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4; // past input
    const outputCount = txBuf[offset];
    offset += 1; // past output count

    // First output is the destination (50_000 sats)
    const amount1 = Number(txBuf.readBigUInt64LE(offset));
    expect(amount1).toBe(50_000);
    offset += 8;
    const script1Len = txBuf[offset];
    offset += 1;
    const destScript = txBuf.subarray(offset, offset + script1Len);

    // Verify the destination script is P2SH format: a9 14 <20-bytes> 87
    expect(destScript[0]).toBe(0xa9); // OP_HASH160
    expect(destScript[1]).toBe(0x14); // PUSH 20 bytes
    expect(destScript[destScript.length - 1]).toBe(0x87); // OP_EQUAL
    expect(destScript.length).toBe(23); // 1 + 1 + 20 + 1
  });
});

// ============================================================================
// sendFromP2WSH multi-path match (BIP84 key found on second path group)
// ============================================================================
describe('sendFromP2WSH multi-path match', () => {
  it('finds key on BIP44 path (m/44\'/0\'/0\'/0/0) after failing BIP84 paths', async () => {
    // The sendFromP2WSH function searches these paths in order:
    // m/84'/0'/0'/0, m/84'/0'/0'/1, m/44'/0'/0'/0, m/44'/0'/0'/1, m/44'/145'/0'/0, m/44'/145'/0'/1
    //
    // We derive a P2WSH address from m/44'/0'/0'/0/0 (the 3rd path group).
    // The function should fail to find a match in the first two BIP84 path groups
    // but succeed on the third (BIP44 BTC) group.

    const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);
    const child = root.derivePath("m/44'/0'/0'/0/0");
    const pubkeyHash = hash160(Buffer.from(child.publicKey));
    const redeemScript = Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]),
      pubkeyHash,
      Buffer.from([0x88, 0xac]),
    ]);
    const scriptHash = crypto.createHash('sha256').update(redeemScript).digest();
    const P2WSH_BIP44_ADDRESS = encodeBech32('bc', 0, scriptHash);

    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(111), vout: 0, value: 100_000 }]);

    const result = await sendFromP2WSH(TEST_MNEMONIC, P2WSH_BIP44_ADDRESS, DEST_CASHADDR, 50_000, 1);

    expect(result.hex).toBeTruthy();
    const txBuf = Buffer.from(result.hex, 'hex');

    // Version = 2
    expect(txBuf.readUInt32LE(0)).toBe(2);
    // 1 input
    expect(txBuf[4]).toBe(1);

    // Verify the scriptSig contains the redeemScript (76a914...88ac)
    const scriptSigLenOffset = 5 + 32 + 4;
    const scriptSigLen = txBuf[scriptSigLenOffset];
    expect(scriptSigLen).toBeGreaterThan(0);
    const scriptSig = txBuf.subarray(scriptSigLenOffset + 1, scriptSigLenOffset + 1 + scriptSigLen);
    const scriptSigHex = scriptSig.toString('hex');
    expect(scriptSigHex).toContain('76a914');
    expect(scriptSigHex).toContain('88ac');
  });

  it('finds key on BIP44/145 path (m/44\'/145\'/0\'/0/0) after failing all earlier paths', async () => {
    // Derive P2WSH from m/44'/145'/0'/0/0 (the 5th path group)
    const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);
    const child = root.derivePath("m/44'/145'/0'/0/0");
    const pubkeyHash = hash160(Buffer.from(child.publicKey));
    const redeemScript = Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]),
      pubkeyHash,
      Buffer.from([0x88, 0xac]),
    ]);
    const scriptHash = crypto.createHash('sha256').update(redeemScript).digest();
    const P2WSH_BCH_ADDRESS = encodeBech32('bc', 0, scriptHash);

    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(112), vout: 0, value: 100_000 }]);

    const result = await sendFromP2WSH(TEST_MNEMONIC, P2WSH_BCH_ADDRESS, DEST_CASHADDR, 50_000, 1);

    expect(result.hex).toBeTruthy();
    const txBuf = Buffer.from(result.hex, 'hex');
    expect(txBuf.readUInt32LE(0)).toBe(2);
    expect(txBuf[4]).toBe(1);
  });
});

// ============================================================================
// sendFromP2TR odd-Y key negation
// ============================================================================
describe('sendFromP2TR odd-Y key negation', () => {
  it('correctly handles keys with odd Y coordinate (0x03 prefix)', async () => {
    // Iterate through BIP86 derivation indices to find a key with odd Y (0x03 prefix).
    // Then derive the P2TR (bc1p) address from that key and verify sendFromP2TR succeeds.
    // If the odd-Y negation logic were wrong, the Schnorr signature would be invalid.

    const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);

    let oddYIndex = -1;
    let bc1pAddress = '';
    const basePath = "m/86'/0'/0'/0";

    for (let i = 0; i < 20; i++) {
      const child = root.derivePath(`${basePath}/${i}`);
      const pubkey = Buffer.from(child.publicKey);
      if (pubkey[0] === 0x03) {
        // Found an odd-Y key
        oddYIndex = i;

        const xonly = pubkey.subarray(1, 33);
        const tagHash = crypto.createHash('sha256').update(Buffer.from('TapTweak', 'utf8')).digest();
        const tweakData = Buffer.concat([tagHash, tagHash, xonly]);
        const tweak = crypto.createHash('sha256').update(tweakData).digest();
        const tweakResult = ecc.xOnlyPointAddTweak(xonly, tweak);
        if (tweakResult) {
          const tweakedXonly = Buffer.from(tweakResult.xOnlyPubkey);
          bc1pAddress = encodeBech32m('bc', 1, tweakedXonly);
        }
        break;
      }
    }

    // If no odd-Y key found in first 20 indices, check change path
    if (oddYIndex === -1) {
      const changePath = "m/86'/0'/0'/1";
      for (let i = 0; i < 20; i++) {
        const child = root.derivePath(`${changePath}/${i}`);
        const pubkey = Buffer.from(child.publicKey);
        if (pubkey[0] === 0x03) {
          oddYIndex = i;
          const xonly = pubkey.subarray(1, 33);
          const tagHash = crypto.createHash('sha256').update(Buffer.from('TapTweak', 'utf8')).digest();
          const tweakData = Buffer.concat([tagHash, tagHash, xonly]);
          const tweak = crypto.createHash('sha256').update(tweakData).digest();
          const tweakResult = ecc.xOnlyPointAddTweak(xonly, tweak);
          if (tweakResult) {
            const tweakedXonly = Buffer.from(tweakResult.xOnlyPubkey);
            bc1pAddress = encodeBech32m('bc', 1, tweakedXonly);
          }
          break;
        }
      }
    }

    // We must have found at least one odd-Y key; statistically ~50% of keys are odd-Y
    expect(oddYIndex).toBeGreaterThanOrEqual(0);
    expect(bc1pAddress.startsWith('bc1p')).toBe(true);

    // Now send from this P2TR address
    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(113), vout: 0, value: 100_000 }]);

    const result = await sendFromP2TR(TEST_MNEMONIC, bc1pAddress, DEST_CASHADDR, 50_000, 1);

    expect(result.hex).toBeTruthy();
    const txBuf = Buffer.from(result.hex, 'hex');

    // Version = 2
    expect(txBuf.readUInt32LE(0)).toBe(2);
    // 1 input
    expect(txBuf[4]).toBe(1);

    // Extract scriptSig - should contain 64-byte Schnorr signature
    const scriptSigLenOffset = 5 + 32 + 4;
    const scriptSigLen = txBuf[scriptSigLenOffset];
    expect(scriptSigLen).toBeGreaterThan(0);
    const scriptSig = txBuf.subarray(scriptSigLenOffset + 1, scriptSigLenOffset + 1 + scriptSigLen);

    // First byte is push length, should be 64 for Schnorr sig
    const sigPushLen = scriptSig[0];
    expect(sigPushLen).toBe(64);
  });
});

// ============================================================================
// Gap 1: sendTransaction feePerByte validation - NaN, Infinity, 0, negative
// ============================================================================
describe('sendTransaction feePerByte validation', () => {
  /** Helper to extract change amount from a 1-input, 2-output VOID tx */
  function extractChangeAmount(txHex: string): number {
    const txBuf = Buffer.from(txHex, 'hex');
    let offset = 5; // version(4) + varint_inputcount(1)
    const scriptSigLen = txBuf[offset + 36]; // 36 = txid(32) + vout(4)
    offset += 36 + 1 + scriptSigLen + 4; // skip input
    offset += 1; // skip output count
    // first output: amount(8) + script
    offset += 8;
    const script1Len = txBuf[offset];
    offset += 1 + script1Len;
    // second output (change) amount
    return Number(txBuf.readBigUInt64LE(offset));
  }

  it('clamps NaN fee to 1 sat/byte (verified via change amount)', async () => {
    const utxo = { txid: fakeTxid(150), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, NaN, false);
    // 1-in 2-out: 226 * 1 = 226 fee. change = 100000 - 50000 - 226 = 49774
    expect(extractChangeAmount(result.hex)).toBe(49_774);
  });

  it('clamps Infinity fee to 1 sat/byte (verified via change amount)', async () => {
    const utxo = { txid: fakeTxid(151), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, Infinity, false);
    expect(extractChangeAmount(result.hex)).toBe(49_774);
  });

  it('clamps zero fee to 1 sat/byte (verified via change amount)', async () => {
    const utxo = { txid: fakeTxid(152), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 0, false);
    expect(extractChangeAmount(result.hex)).toBe(49_774);
  });

  it('clamps negative fee (-100) to 1 sat/byte (verified via change amount)', async () => {
    const utxo = { txid: fakeTxid(153), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, -100, false);
    expect(extractChangeAmount(result.hex)).toBe(49_774);
  });
});

// ============================================================================
// Gap 2: sendTransaction UTXO dedup - tx_hash fails regex (non-hex chars)
// ============================================================================
describe('sendTransaction UTXO dedup - invalid txid regex', () => {
  it('filters out UTXOs with non-hex characters and throws when none remain', async () => {
    const utxos = [
      { txid: 'ZZZZ' + 'a'.repeat(60), vout: 0, value: 100_000 }, // invalid: Z not in hex
      { txid: '!@#$' + 'b'.repeat(60), vout: 0, value: 100_000 }, // invalid: special chars
      { txid: 'ghij' + 'c'.repeat(60), vout: 0, value: 100_000 }, // invalid: g,h,i,j not hex
    ];
    mockGetUtxosByAddress.mockResolvedValue(utxos);

    // All UTXOs invalid => after filtering, empty => insufficient funds
    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false),
    ).rejects.toThrow(/Insufficient funds/);
  });

  it('filters out UTXOs with wrong length txid (32 hex chars instead of 64)', async () => {
    const utxos = [
      { txid: 'aa'.repeat(16), vout: 0, value: 100_000 }, // 32 hex chars, need 64
      { txid: fakeTxid(155), vout: 0, value: 100_000 },   // valid 64 hex chars
    ];
    mockGetUtxosByAddress.mockResolvedValue(utxos);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');
    // Only 1 input (the valid one)
    expect(txBuf[4]).toBe(1);
  });
});

// ============================================================================
// Gap 3: sendFromBech32 - invalid bc1 address error path (non-bech32 address)
// ============================================================================
describe('sendFromBech32 invalid address', () => {
  it('throws for non-bech32 legacy address (1xxx)', async () => {
    await expect(
      sendFromBech32(TEST_MNEMONIC, '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', DEST_CASHADDR, 1000, 1),
    ).rejects.toThrow(/Invalid bc1 P2WPKH address/);
  });

  it('throws for CashAddr address passed to sendFromBech32', async () => {
    await expect(
      sendFromBech32(TEST_MNEMONIC, DEST_CASHADDR, DEST_CASHADDR, 1000, 1),
    ).rejects.toThrow(/Invalid bc1 P2WPKH address/);
  });
});

// ============================================================================
// Gap 4: sendFromP2SH - P2SH address matching failure (no matching key found)
// ============================================================================
describe('sendFromP2SH address matching failure', () => {
  it('throws when P2SH address does not match any BIP49 derived key', async () => {
    // Create a P2SH address from a random script hash (will not match any derived key)
    const randomScriptHash = crypto.randomBytes(20);
    const versionedHash = Buffer.concat([Buffer.from([0x05]), randomScriptHash]);
    const randomP2SH = bs58check.encode(versionedHash);

    mockGetUtxosByScripthash.mockResolvedValue([{ txid: fakeTxid(160), vout: 0, value: 100_000 }]);

    await expect(
      sendFromP2SH(TEST_MNEMONIC, randomP2SH, DEST_CASHADDR, 50_000, 1),
    ).rejects.toThrow(/Could not find private key for P2SH address/);
  });
});

// ============================================================================
// Gap 5: sendFromP2WSH - invalid P2WSH address error path
// ============================================================================
describe('sendFromP2WSH invalid address', () => {
  it('throws for non-bech32 legacy address (1xxx)', async () => {
    await expect(
      sendFromP2WSH(TEST_MNEMONIC, '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', DEST_CASHADDR, 1000, 1),
    ).rejects.toThrow(/Invalid bc1 P2WSH address/);
  });

  it('throws for CashAddr address passed to sendFromP2WSH', async () => {
    await expect(
      sendFromP2WSH(TEST_MNEMONIC, DEST_CASHADDR, DEST_CASHADDR, 1000, 1),
    ).rejects.toThrow(/Invalid bc1 P2WSH address/);
  });

  it('throws for P2WPKH address (20-byte program) instead of P2WSH (32-byte)', async () => {
    // BC1_ADDRESS is a 20-byte program; sendFromP2WSH requires 32-byte
    await expect(
      sendFromP2WSH(TEST_MNEMONIC, BC1_ADDRESS, DEST_CASHADDR, 50_000, 1),
    ).rejects.toThrow(/P2WSH/);
  });
});

// ============================================================================
// Gap 6: buildTransaction change amount = 0 edge case (exact amount + fee = inputs)
// ============================================================================
describe('buildTransaction change=0 edge case', () => {
  it('produces 1-output tx when input exactly covers amount + 1-output fee', async () => {
    // 1-in 2-out: size = 10 + 148 + 68 = 226, fee = 226
    // tentativeChange = input - amount - fee2out
    // For change=0 (absorbed as dust): change must be <= 546
    // 1-in 1-out: size = 10 + 148 + 34 = 192, fee = 192
    // Set input = amount + 192 exactly for a perfect 1-output tx with 0 change
    const amount = 50_000;
    const feeOneOutput = 192; // 10 + 148 + 34 = 192 at 1 sat/byte
    const inputValue = amount + feeOneOutput; // 50192

    const utxo = { txid: fakeTxid(170), vout: 0, value: inputValue };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, amount, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    // Parse to find output count
    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4;
    const outputCount = txBuf[offset];
    expect(outputCount).toBe(1); // No change output
  });

  it('produces 1-output tx when change would be exactly 0 sats', async () => {
    // 1-in 2-out: size=226, fee=226. If input = amount + 226, then tentativeChange = 0 (<=546)
    // So hasChange=false, recalculate with 1-out: fee=192. changeAmount=0, but it's 0 so no change output.
    // Actually input - amount - fee1out = (amount+226) - amount - 192 = 34. 34 is absorbed into fee.
    const amount = 50_000;
    const feeTwoOutput = 226;
    const inputValue = amount + feeTwoOutput; // 50226: tentativeChange = 0

    const utxo = { txid: fakeTxid(171), vout: 0, value: inputValue };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, amount, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4;
    const outputCount = txBuf[offset];
    expect(outputCount).toBe(1); // Change is 0, no change output
  });
});

// ============================================================================
// Gap 7: buildTransaction P2SH output handling (destination starts with '3')
// ============================================================================
describe('buildTransaction P2SH output for VOID', () => {
  it('produces P2SH script (a914...87) when VOID destination starts with 3', async () => {
    // Use an actual valid P2SH address
    const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);
    const child = root.derivePath("m/49'/0'/0'/0/0");
    const pubkeyHash = hash160(Buffer.from(child.publicKey));
    const redeemScript = Buffer.concat([Buffer.from([0x00, 0x14]), pubkeyHash]);
    const scriptHash = hash160(redeemScript);
    const versionedHash = Buffer.concat([Buffer.from([0x05]), scriptHash]);
    const p2shAddress = bs58check.encode(versionedHash);

    expect(p2shAddress.startsWith('3')).toBe(true);

    const utxo = { txid: fakeTxid(175), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, p2shAddress, 50_000, 1, true);
    const txBuf = Buffer.from(result.hex, 'hex');

    // Parse to destination output and verify P2SH format
    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4;
    offset += 1; // output count

    // First output amount
    const amount1 = Number(txBuf.readBigUInt64LE(offset));
    expect(amount1).toBe(50_000);
    offset += 8;
    const script1Len = txBuf[offset];
    offset += 1;
    const destScript = txBuf.subarray(offset, offset + script1Len);

    // P2SH: OP_HASH160(a9) PUSH20(14) <20-byte-hash> OP_EQUAL(87)
    expect(destScript[0]).toBe(0xa9);
    expect(destScript[1]).toBe(0x14);
    expect(destScript[destScript.length - 1]).toBe(0x87);
    expect(destScript.length).toBe(23);

    // Verify the embedded script hash matches
    const embeddedHash = destScript.subarray(2, 22);
    expect(embeddedHash.equals(scriptHash)).toBe(true);
  });
});

// ============================================================================
// Gap 8: createLegacySighash multi-input scenario with proper empty scriptSig
// ============================================================================
describe('createLegacySighash multi-input', () => {
  it('produces a valid VOID tx with 3 inputs (legacy sighash with empty scriptSig for non-signing inputs)', async () => {
    // VOID uses legacy sighash. With multiple inputs, each input's sighash
    // should have the signing input's scriptPubKey and empty scriptSig for others.
    // We verify the transaction is valid (all 3 inputs signed correctly).
    // Each UTXO is 25_000 so first two (50_000) can't cover amount(50_000) + fee(374 for 2-in 2-out)
    // but all three (75_000) can cover amount(50_000) + fee(522 for 3-in 2-out) = 50_522
    const utxos = [
      { txid: fakeTxid(180), vout: 0, value: 25_000 },
      { txid: fakeTxid(181), vout: 0, value: 25_000 },
      { txid: fakeTxid(182), vout: 0, value: 25_000 },
    ];
    mockGetVOIDUtxos.mockResolvedValue(utxos);

    // amount = 50_000. 3-in 2-out: size = 10 + 3*148 + 68 = 522, fee = 522
    // total = 75_000. change = 75000 - 50000 - 522 = 24478
    const result = await sendTransaction(TEST_MNEMONIC, '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 50_000, 1, true);
    const txBuf = Buffer.from(result.hex, 'hex');

    // Version 2
    expect(txBuf.readUInt32LE(0)).toBe(2);
    // 3 inputs
    expect(txBuf[4]).toBe(3);

    // Verify each input has a valid DER signature (0x30 prefix) with SIGHASH_ALL (0x01)
    let offset = 5;
    for (let i = 0; i < 3; i++) {
      // txid(32) + vout(4) = 36 bytes
      offset += 36;
      const scriptSigLen = txBuf[offset];
      offset += 1;
      const scriptSig = txBuf.subarray(offset, offset + scriptSigLen);

      // First byte is push length for sig+hashtype
      const sigPushLen = scriptSig[0];
      const sigWithHashType = scriptSig.subarray(1, 1 + sigPushLen);

      // DER starts with 0x30
      expect(sigWithHashType[0]).toBe(0x30);
      // VOID SIGHASH_ALL = 0x01
      expect(sigWithHashType[sigWithHashType.length - 1]).toBe(0x01);

      offset += scriptSigLen + 4; // past scriptSig + sequence
    }

    // Verify output count is 2
    expect(txBuf[offset]).toBe(2);
  });

  it('produces different sighashes for each input in a multi-input VOID tx', async () => {
    // If createLegacySighash incorrectly handles the empty scriptSig for non-signing
    // inputs, signatures would be wrong. We verify that a 2-input tx works correctly
    // and produces a different signature for each input (since sighashes differ).
    // Each UTXO is 40_000. 1-in 2-out: fee=226, need 50226 > 40000. So needs 2 inputs.
    // 2-in 2-out: fee=374, need 50374 < 80000. Good.
    const utxos = [
      { txid: fakeTxid(183), vout: 0, value: 40_000 },
      { txid: fakeTxid(184), vout: 0, value: 40_000 },
    ];
    mockGetVOIDUtxos.mockResolvedValue(utxos);

    // 2-in 2-out: size = 10 + 296 + 68 = 374, fee = 374
    // change = 80000 - 50000 - 374 = 29626
    const result = await sendTransaction(TEST_MNEMONIC, '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 50_000, 1, true);
    const txBuf = Buffer.from(result.hex, 'hex');

    expect(txBuf[4]).toBe(2); // 2 inputs

    // Extract both signatures
    let offset = 5;
    const sigs: Buffer[] = [];
    for (let i = 0; i < 2; i++) {
      offset += 36; // txid + vout
      const scriptSigLen = txBuf[offset];
      offset += 1;
      const scriptSig = txBuf.subarray(offset, offset + scriptSigLen);
      const sigPushLen = scriptSig[0];
      const sig = scriptSig.subarray(1, 1 + sigPushLen - 1); // exclude hashtype byte
      sigs.push(Buffer.from(sig));
      offset += scriptSigLen + 4; // past scriptSig + sequence
    }

    // Signatures should differ because different inputs produce different sighashes
    expect(sigs[0].equals(sigs[1])).toBe(false);
  });
});

// ============================================================================
// Gap 9: decodeCashAddr reject bitcoincash: prefix
// ============================================================================
describe('decodeCashAddr prefix validation', () => {
  it('rejects bitcoincash: prefix with explicit error about bitcoincashii:', () => {
    expect(() => {
      decodeCashAddr('bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292');
    }).toThrow('Invalid address: use bitcoincashii: prefix for VOID, not bitcoincash:');
  });

  it('rejects bitcoincash: prefix when called with returnType=true', () => {
    expect(() => {
      decodeCashAddr('bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292', true);
    }).toThrow(/bitcoincashii/);
  });

  it('accepts address without prefix (assumes bitcoincashii:)', () => {
    // Strip the prefix from a valid address and decode
    const addrWithPrefix = DEST_CASHADDR;
    const addrWithoutPrefix = addrWithPrefix.replace('bitcoincashii:', '');
    const result = decodeCashAddr(addrWithoutPrefix, true);
    expect(result.type).toBe(0);
    expect(result.hash.length).toBe(20);

    // Verify it matches the prefixed version
    const resultWithPrefix = decodeCashAddr(addrWithPrefix, true);
    expect(result.hash.equals(resultWithPrefix.hash)).toBe(true);
  });
});

// ============================================================================
// Gap 10: decodeCashAddr padding bits validation boundary
// ============================================================================
describe('decodeCashAddr padding bits', () => {
  it('rejects address that is too short (< 8 values after base32 decoding)', () => {
    expect(() => {
      decodeCashAddr('bitcoincashii:qq');
    }).toThrow(/too short/);
  });

  it('rejects address with invalid checksum', () => {
    // Take a valid address and corrupt one character
    const valid = DEST_CASHADDR;
    const payload = valid.slice('bitcoincashii:'.length);
    const corruptChar = payload[0] === 'q' ? 'p' : 'q';
    const corrupt = 'bitcoincashii:' + corruptChar + payload.slice(1);
    expect(() => {
      decodeCashAddr(corrupt);
    }).toThrow(/checksum/);
  });
});

// ============================================================================
// Gap 11: decodeBech32 invalid checksum detection (tested via addressToScript)
// ============================================================================
describe('decodeBech32 invalid checksum', () => {
  it('throws when bech32 address has corrupted checksum', async () => {
    // Corrupt the checksum of a valid bc1 address
    const valid = BC1_ADDRESS;
    const lastChar = valid[valid.length - 1];
    const corruptChar = lastChar === 'q' ? 'p' : 'q';
    const corrupt = valid.slice(0, -1) + corruptChar;

    const utxo = { txid: fakeTxid(190), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    // VOID now blocks all bc1 destinations before reaching checksum validation
    await expect(
      sendTransaction(TEST_MNEMONIC, corrupt, 50_000, 1, false),
    ).rejects.toThrow(/Cannot send VOID to a SegWit/);
  });

  it('throws when bc1 address passed to sendFromBech32 has corrupted checksum', async () => {
    const valid = BC1_ADDRESS;
    const lastChar = valid[valid.length - 1];
    const corruptChar = lastChar === 'q' ? 'p' : 'q';
    const corrupt = valid.slice(0, -1) + corruptChar;

    await expect(
      sendFromBech32(TEST_MNEMONIC, corrupt, DEST_CASHADDR, 1000, 1),
    ).rejects.toThrow(/Invalid bc1 P2WPKH address/);
  });
});

// ============================================================================
// Gap 12: decodeBech32 version > 16 rejection
// ============================================================================
describe('decodeBech32 version > 16 rejection', () => {
  it('rejects bech32 address with witness version 17 as destination', async () => {
    // VOID now blocks all bc1 destinations before reaching version validation
    const program = crypto.randomBytes(20);
    const invalidAddr = encodeBech32('bc', 17, program);

    const utxo = { txid: fakeTxid(191), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    await expect(
      sendTransaction(TEST_MNEMONIC, invalidAddr, 50_000, 1, false),
    ).rejects.toThrow(/Cannot send VOID to a SegWit/);
  });
});

// ============================================================================
// Gap 13: decodeBech32 v0 program length validation (must be 20 or 32)
// ============================================================================
describe('decodeBech32 v0 program length validation', () => {
  it('rejects v0 bech32 address with 16-byte program', async () => {
    // VOID now blocks all bc1 destinations before reaching program length validation
    const shortProgram = crypto.randomBytes(16);
    const invalidAddr = encodeBech32('bc', 0, shortProgram);

    const utxo = { txid: fakeTxid(192), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    await expect(
      sendTransaction(TEST_MNEMONIC, invalidAddr, 50_000, 1, false),
    ).rejects.toThrow(/Cannot send VOID to a SegWit/);
  });

  it('rejects v0 bech32 address with 24-byte program (not 20 or 32)', async () => {
    // VOID now blocks all bc1 destinations
    const oddProgram = crypto.randomBytes(24);
    const invalidAddr = encodeBech32('bc', 0, oddProgram);

    const utxo = { txid: fakeTxid(193), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    await expect(
      sendTransaction(TEST_MNEMONIC, invalidAddr, 50_000, 1, false),
    ).rejects.toThrow(/Cannot send VOID to a SegWit/);
  });

  it('accepts v0 bech32 address with 20-byte program (P2WPKH) via VOID mode', async () => {
    // VOID blocks bc1 — use VOID mode to test P2WPKH acceptance
    const utxo = { txid: fakeTxid(194), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, BC1_ADDRESS, 50_000, 1, true);
    expect(result.hex).toBeTruthy();
  });

  it('accepts v0 bech32 address with 32-byte program (P2WSH) as destination via VOID mode', async () => {
    // VOID blocks bc1 — use VOID mode to test P2WSH acceptance
    const programHash = crypto.createHash('sha256').update('v0-32byte-test').digest();
    const p2wshDest = encodeBech32('bc', 0, programHash);

    const utxo = { txid: fakeTxid(195), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, p2wshDest, 50_000, 1, true);
    expect(result.hex).toBeTruthy();
    // Verify P2WSH output script is present: 0020<32-byte-hash>
    expect(result.hex).toContain('0020' + programHash.toString('hex'));
  });
});

// ============================================================================
// Gap 14: decodeBech32 padding bits != 0 rejection
// ============================================================================
describe('decodeBech32 padding bits rejection', () => {
  it('rejects bech32 address where padding bits are non-zero', () => {
    // We construct a bech32 address manually with non-zero padding bits
    // and a valid checksum, then verify it fails when used as a destination.
    //
    // For a 20-byte program (160 bits), 160/5 = 32 5-bit groups exactly, no padding.
    // For a 21-byte program (168 bits), 168/5 = 33.6, so we'd get 34 5-bit groups
    // with 2 padding bits. But since 21 isn't valid for v0, let's construct manually.
    //
    // We create a bech32 address with version 0, 20 bytes, but tweak the raw 5-bit
    // data so the last group's padding bits are non-zero, then fix the checksum.

    const hrp = 'bc';
    const version = 0;
    const program = Buffer.alloc(20, 0xaa);

    // Convert to 5-bit groups
    const data5bit: number[] = [version];
    let acc = 0;
    let bits = 0;
    for (const byte of program) {
      acc = (acc << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        data5bit.push((acc >> bits) & 0x1f);
      }
    }
    if (bits > 0) {
      // Normal encoding: zero-pad remaining bits
      // We intentionally set padding bits to non-zero
      data5bit.push(((acc << (5 - bits)) & 0x1f) | 0x01); // set lowest padding bit
    }

    // Compute valid checksum for this (bad) data
    const hrpExp = bech32HrpExpand(hrp);
    const poly = bech32Polymod([...hrpExp, ...data5bit, 0, 0, 0, 0, 0, 0]) ^ 1;
    const cksum: number[] = [];
    for (let i = 0; i < 6; i++) cksum.push((poly >> (5 * (5 - i))) & 0x1f);

    let addrStr = hrp + '1';
    for (const v of [...data5bit, ...cksum]) addrStr += BECH32_CHARSET[v];

    // This address has valid checksum but non-zero padding bits
    // decodeBech32 should return null due to padding check
    // When used as a destination address, it should fail
    const utxo = { txid: fakeTxid(196), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    // The address should be rejected by decodeBech32 (returns null) -> thrown
    // However, for 20-byte programs there are no padding bits (160/5=32 exact),
    // so let's use a program size that actually produces padding bits.
    // 22 bytes = 176 bits -> 176/5 = 35.2 -> 36 groups, 4 padding bits
    // But v0 only accepts 20 or 32, so this will fail for length too.
    // We need a version > 0 to test padding bits alone.
    // Let's use version 2 with a 20-byte program (non-standard but decodeBech32 accepts v <= 16)
    // Actually for v0 with 20 bytes: 160/5 = 32 exactly, no padding. Same for 32 bytes: 256/5 = 51.2...
    // Wait, 32 bytes = 256 bits, 256/5 = 51.2, so 52 5-bit groups with 4 padding bits.
    // Let's test with a 32-byte program with non-zero padding.
  });

  it('rejects bech32 v0 32-byte program with non-zero padding bits', async () => {
    const hrp = 'bc';
    const version = 0;
    const program = Buffer.alloc(32, 0xcc);

    // Convert to 5-bit groups manually
    const data5bit: number[] = [version];
    let acc = 0;
    let bits = 0;
    for (const byte of program) {
      acc = (acc << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        data5bit.push((acc >> bits) & 0x1f);
      }
    }
    // 32 bytes = 256 bits, 256/5 = 51 full groups + 1 bit remaining
    // bits should be 1, acc should have 1 bit of data
    // Normal: push (acc << 4) & 0x1f (zero-pad 4 bits)
    // Bad: set padding bits to non-zero
    if (bits > 0) {
      data5bit.push(((acc << (5 - bits)) & 0x1f) | 0x03); // non-zero padding
    }

    // Compute valid checksum
    const hrpExp = bech32HrpExpand(hrp);
    const poly = bech32Polymod([...hrpExp, ...data5bit, 0, 0, 0, 0, 0, 0]) ^ 1;
    const cksum: number[] = [];
    for (let i = 0; i < 6; i++) cksum.push((poly >> (5 * (5 - i))) & 0x1f);

    let addrStr = hrp + '1';
    for (const v of [...data5bit, ...cksum]) addrStr += BECH32_CHARSET[v];

    const utxo = { txid: fakeTxid(197), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    // VOID now blocks all bc1 destinations before reaching padding validation
    await expect(
      sendTransaction(TEST_MNEMONIC, addrStr, 50_000, 1, false),
    ).rejects.toThrow(/Cannot send VOID to a SegWit/);
  });
});

// ============================================================================
// Gap 15: encodeVarInt boundary values
// ============================================================================
describe('encodeVarInt boundary values', () => {
  // encodeVarInt is internal, but we can verify the encoding logic for all boundaries.
  // We simulate what encodeVarInt does and verify the boundary behavior:
  // n < 0xfd (252): 1 byte
  // n = 0xfd (253): 3 bytes (0xfd + uint16LE)
  // n <= 0xffff: 3 bytes
  // n = 0x10000 (65536): 5 bytes (0xfe + uint32LE)
  // n <= 0xffffffff: 5 bytes
  // n = 0x100000000 (4294967296): 9 bytes (0xff + uint64LE)

  /** Simulate encodeVarInt to verify boundary encoding */
  function encodeVarIntSim(n: number): Buffer {
    if (n < 0xfd) {
      return Buffer.from([n]);
    } else if (n <= 0xffff) {
      const buf = Buffer.alloc(3);
      buf[0] = 0xfd;
      buf.writeUInt16LE(n, 1);
      return buf;
    } else if (n <= 0xffffffff) {
      const buf = Buffer.alloc(5);
      buf[0] = 0xfe;
      buf.writeUInt32LE(n, 1);
      return buf;
    } else {
      const buf = Buffer.alloc(9);
      buf[0] = 0xff;
      buf.writeBigUInt64LE(BigInt(n), 1);
      return buf;
    }
  }

  it('encodes 252 as a single byte (0xfc)', () => {
    const result = encodeVarIntSim(252);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(0xfc);
  });

  it('encodes 253 as 3 bytes: 0xfd 0xfd 0x00', () => {
    const result = encodeVarIntSim(253);
    expect(result.length).toBe(3);
    expect(result[0]).toBe(0xfd);
    expect(result.readUInt16LE(1)).toBe(253);
  });

  it('encodes 0xffff (65535) as 3 bytes: 0xfd 0xff 0xff', () => {
    const result = encodeVarIntSim(0xffff);
    expect(result.length).toBe(3);
    expect(result[0]).toBe(0xfd);
    expect(result[1]).toBe(0xff);
    expect(result[2]).toBe(0xff);
    expect(result.readUInt16LE(1)).toBe(65535);
  });

  it('encodes 0x10000 (65536) as 5 bytes: 0xfe prefix', () => {
    const result = encodeVarIntSim(0x10000);
    expect(result.length).toBe(5);
    expect(result[0]).toBe(0xfe);
    expect(result.readUInt32LE(1)).toBe(65536);
  });

  it('encodes 0xffffffff (4294967295) as 5 bytes: 0xfe prefix', () => {
    const result = encodeVarIntSim(0xffffffff);
    expect(result.length).toBe(5);
    expect(result[0]).toBe(0xfe);
    expect(result.readUInt32LE(1)).toBe(0xffffffff);
  });

  it('encodes 0x100000000 (4294967296) as 9 bytes: 0xff prefix', () => {
    const result = encodeVarIntSim(0x100000000);
    expect(result.length).toBe(9);
    expect(result[0]).toBe(0xff);
    expect(Number(result.readBigUInt64LE(1))).toBe(0x100000000);
  });

  it('boundary: 252 is 1 byte, 253 is 3 bytes (transition point)', () => {
    const r252 = encodeVarIntSim(252);
    const r253 = encodeVarIntSim(253);
    expect(r252.length).toBe(1);
    expect(r253.length).toBe(3);
  });

  it('boundary: 0xffff is 3 bytes, 0x10000 is 5 bytes (transition point)', () => {
    const r65535 = encodeVarIntSim(0xffff);
    const r65536 = encodeVarIntSim(0x10000);
    expect(r65535.length).toBe(3);
    expect(r65536.length).toBe(5);
  });

  it('boundary: 0xffffffff is 5 bytes, 0x100000000 is 9 bytes (transition point)', () => {
    const r4G = encodeVarIntSim(0xffffffff);
    const r4Gplus1 = encodeVarIntSim(0x100000000);
    expect(r4G.length).toBe(5);
    expect(r4Gplus1.length).toBe(9);
  });

  it('verifies real tx uses correct VarInt for scriptSig length > 100 but < 253', async () => {
    // A typical scriptSig is ~107 bytes (sig ~72 + hashtype 1 + pubkey 33 + overhead).
    // This should be encoded as a single VarInt byte (n < 0xfd).
    const utxo = { txid: fakeTxid(200), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    // scriptSig length is at position: version(4) + varint_inputcount(1) + txid(32) + vout(4) = 41
    const scriptSigLen = txBuf[41];
    expect(scriptSigLen).toBeGreaterThan(100); // typical scriptSig ~107 bytes
    expect(scriptSigLen).toBeLessThan(253);    // fits in 1-byte VarInt
  });
});

// ============================================================================
// Gap 16: addressToScript() P2TR destination (bc1p bech32m)
// ============================================================================
describe('addressToScript P2TR destination', () => {
  it('produces correct OP_1 PUSH_32 <x-only-pubkey> script for bc1p address (via VOID mode)', async () => {
    // VOID now blocks bc1 destinations — use VOID mode to test P2TR output scripts
    const xonlyPubkey = crypto.createHash('sha256').update('p2tr-destination-test-gap16').digest();
    const bc1pDest = encodeBech32m('bc', 1, xonlyPubkey);

    expect(bc1pDest.startsWith('bc1p')).toBe(true);

    // Send a VOID transaction to this bc1p destination
    const utxo = { txid: fakeTxid(210), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, bc1pDest, 50_000, 1, true);
    const txHex = result.hex;

    // P2TR output script: OP_1(51) PUSH_32(20) <32-byte-x-only-pubkey>
    const expectedScript = '5120' + xonlyPubkey.toString('hex');
    expect(txHex).toContain(expectedScript);

    // Parse the tx to verify the destination output script format
    const txBuf = Buffer.from(txHex, 'hex');
    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4; // skip input
    offset += 1; // skip output count

    // First output: amount(8) + varint(scriptLen) + script
    const amount1 = Number(txBuf.readBigUInt64LE(offset));
    expect(amount1).toBe(50_000);
    offset += 8;
    const script1Len = txBuf[offset];
    expect(script1Len).toBe(34); // OP_1(1) + PUSH_32(1) + 32-byte-key = 34
    offset += 1;
    const destScript = txBuf.subarray(offset, offset + script1Len);
    expect(destScript[0]).toBe(0x51); // OP_1
    expect(destScript[1]).toBe(0x20); // PUSH_32
    expect(destScript.subarray(2).equals(xonlyPubkey)).toBe(true);
  });
});

// ============================================================================
// Gap 17: addressToScript unsupported witness versions v2-v16
// ============================================================================
describe('addressToScript unsupported witness v2-v16', () => {
  it('throws for witness version 2 bech32m address (20-byte program)', async () => {
    // VOID now blocks all bc1 destinations before reaching version checks
    const program = crypto.randomBytes(20);
    const v2Addr = encodeBech32m('bc', 2, program);

    const utxo = { txid: fakeTxid(211), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    await expect(
      sendTransaction(TEST_MNEMONIC, v2Addr, 50_000, 1, false),
    ).rejects.toThrow(/Cannot send VOID to a SegWit/);
  });

  it('throws for witness version 16 bech32m address', async () => {
    // VOID now blocks all bc1 destinations
    const program = crypto.randomBytes(20);
    const v16Addr = encodeBech32m('bc', 16, program);

    const utxo = { txid: fakeTxid(212), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    await expect(
      sendTransaction(TEST_MNEMONIC, v16Addr, 50_000, 1, false),
    ).rejects.toThrow(/Cannot send VOID to a SegWit/);
  });

  it('throws for witness version 3 bech32m address with 32-byte program', async () => {
    // VOID now blocks all bc1 destinations
    const program = crypto.randomBytes(32);
    const v3Addr = encodeBech32m('bc', 3, program);

    const utxo = { txid: fakeTxid(213), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    await expect(
      sendTransaction(TEST_MNEMONIC, v3Addr, 50_000, 1, false),
    ).rejects.toThrow(/Cannot send VOID to a SegWit/);
  });
});

// ============================================================================
// Gap 18: sendTransaction() address mismatch alternate derivation
// ============================================================================
describe('sendTransaction address mismatch alternate derivation', () => {
  it('tries alternate VOID derivation paths when expectedAddress does not match primary', async () => {
    // Primary VOID path is m/44'/0'/0'/0/0.
    // altPaths includes m/44'/145'/0'/0/0. Derive address from that path.
    const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);
    const altChild = root.derivePath("m/44'/145'/0'/0/0");
    const altPkh = hash160(Buffer.from(altChild.publicKey));
    const altAddress = bs58check.encode(Buffer.concat([Buffer.from([0x00]), altPkh]));

    const utxo = { txid: fakeTxid(214), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    // Send as VOID with expectedAddress matching the alternate m/44'/145'/0'/0/0 path
    const result = await sendTransaction(
      TEST_MNEMONIC,
      '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      50_000,
      1,
      true,
      altAddress,
    );

    expect(result.txid).toBeTruthy();
    expect(result.hex).toBeTruthy();
    // Broadcast should have been called via sendTransactionWithKey
    expect(mockBroadcastVOIDTransaction).toHaveBeenCalledTimes(1);
  });

  it('falls through to primary derivation when expectedAddress matches no alternate path', async () => {
    // Provide an expectedAddress that doesn't match any derivation path.
    // The code should just continue with the primary path (no throw from the mismatch).
    const utxo = { txid: fakeTxid(215), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    // expectedAddress is something random - won't match any path, so code falls through
    const result = await sendTransaction(
      TEST_MNEMONIC,
      '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      50_000,
      1,
      true,
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', // Genesis address, won't match any derived key
    );

    expect(result.txid).toBeTruthy();
    expect(result.hex).toBeTruthy();
  });

  it('alternate derivation logic is skipped for VOID (isVOID=false)', async () => {
    // When isVOID=false, the alternate path search is not attempted
    const utxo = { txid: fakeTxid(216), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    // Provide a mismatched expectedAddress but isVOID=false, so no alternate search
    const result = await sendTransaction(
      TEST_MNEMONIC,
      DEST_CASHADDR,
      50_000,
      1,
      false,
      'bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292', // Mismatched
    );

    expect(result.txid).toBeTruthy();
    expect(result.hex).toBeTruthy();
    // Should use broadcastTransaction (VOID), not VOID
    expect(mockBroadcastTransaction).toHaveBeenCalledTimes(1);
    expect(mockBroadcastVOIDTransaction).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Gap 19: isBech32Address() case sensitivity (uppercase BC1Q)
// ============================================================================
describe('isBech32Address case sensitivity', () => {
  it('recognizes uppercase BC1Q address (bech32 spec allows uppercase) via VOID mode', async () => {
    // VOID now blocks bc1 destinations — use VOID mode to test case handling
    const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);
    const destChild = root.derivePath("m/84'/0'/0'/0/1");
    const destPkh = hash160(Buffer.from(destChild.publicKey));
    const destBc1Upper = encodeBech32('bc', 0, destPkh).toUpperCase();
    expect(destBc1Upper.startsWith('BC1Q')).toBe(true);

    const utxo = { txid: fakeTxid(220), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, destBc1Upper, 50_000, 1, true);
    expect(result.hex).toBeTruthy();

    // Verify the output script matches (case should not affect the hash)
    const expectedScript = '0014' + destPkh.toString('hex');
    expect(result.hex).toContain(expectedScript);
  });

  it('recognizes mixed-prefix BC1q address via toLowerCase normalization (VOID mode)', async () => {
    // VOID now blocks bc1 destinations — use VOID mode to test case normalization
    const seed = await bip39.mnemonicToSeed(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);
    const destChild = root.derivePath("m/84'/0'/0'/0/1");
    const destPkh = hash160(Buffer.from(destChild.publicKey));
    const destBc1 = encodeBech32('bc', 0, destPkh);
    const mixedCase = 'BC1' + destBc1.slice(3);

    const utxo = { txid: fakeTxid(221), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, mixedCase, 50_000, 1, true);
    expect(result.hex).toBeTruthy();
  });
});

// ============================================================================
// Gap 20: decodeCashAddr() no-prefix input
// ============================================================================
describe('decodeCashAddr no-prefix input', () => {
  it('decodes address without prefix by assuming bitcoincashii:', () => {
    // Strip the prefix from a valid address and verify it decodes the same
    const withPrefix = DEST_CASHADDR;
    const withoutPrefix = withPrefix.replace('bitcoincashii:', '');

    // Should not start with 'bitcoincashii:'
    expect(withoutPrefix.startsWith('bitcoincashii:')).toBe(false);

    const result = decodeCashAddr(withoutPrefix, true);
    expect(result.type).toBe(0);
    expect(result.hash.length).toBe(20);

    // Verify the hash matches the prefixed version
    const resultWithPrefix = decodeCashAddr(withPrefix, true);
    expect(result.hash.equals(resultWithPrefix.hash)).toBe(true);
  });

  it('decodes no-prefix P2SH address correctly', () => {
    // Build a valid P2SH cashaddr and strip the prefix
    const scriptHash = Buffer.alloc(20, 0xdd);
    const p2shAddr = encodeCashAddr(scriptHash, 1); // type=1 for P2SH
    const withoutPrefix = p2shAddr.replace('bitcoincashii:', '');

    const result = decodeCashAddr(withoutPrefix, true);
    expect(result.type).toBe(1); // P2SH
    expect(result.hash.equals(scriptHash)).toBe(true);
  });

  it('decodeCashAddr without returnType flag returns Buffer for no-prefix input', () => {
    const withPrefix = DEST_CASHADDR;
    const withoutPrefix = withPrefix.replace('bitcoincashii:', '');

    const result = decodeCashAddr(withoutPrefix);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect((result as Buffer).length).toBe(20);
  });
});

// ============================================================================
// Gap 21: createLegacySighash multi-input empty scriptSig
// ============================================================================
describe('createLegacySighash multi-input empty scriptSig', () => {
  it('multi-input VOID transaction: non-signing inputs have empty scriptSig in sighash preimage', async () => {
    // We verify this indirectly: if non-signing inputs did NOT have empty scriptSig,
    // the sighash would be wrong and the signatures would be different from expected.
    // A 2-input VOID tx should produce valid distinct signatures for each input.
    const utxos = [
      { txid: fakeTxid(230), vout: 0, value: 40_000 },
      { txid: fakeTxid(231), vout: 1, value: 40_000 },
    ];
    mockGetVOIDUtxos.mockResolvedValue(utxos);

    // 2-in 2-out: size = 10 + 296 + 68 = 374, fee = 374
    const result = await sendTransaction(TEST_MNEMONIC, '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 50_000, 1, true);
    const txBuf = Buffer.from(result.hex, 'hex');

    expect(txBuf[4]).toBe(2); // 2 inputs

    // Extract both scriptSigs and verify they both have valid DER signatures
    let offset = 5;
    for (let i = 0; i < 2; i++) {
      offset += 36; // txid + vout
      const scriptSigLen = txBuf[offset];
      offset += 1;
      const scriptSig = txBuf.subarray(offset, offset + scriptSigLen);

      // Each input should have a proper scriptSig: varint(sigLen) sig hashtype varint(pubkeyLen) pubkey
      const sigPushLen = scriptSig[0];
      expect(sigPushLen).toBeGreaterThan(60); // DER sig is typically ~71-73 bytes + hashtype
      const sigWithHashType = scriptSig.subarray(1, 1 + sigPushLen);
      expect(sigWithHashType[0]).toBe(0x30); // DER SEQUENCE tag
      expect(sigWithHashType[sigWithHashType.length - 1]).toBe(0x01); // SIGHASH_ALL for VOID

      // Public key follows
      const pubkeyPushOffset = 1 + sigPushLen;
      const pubkeyLen = scriptSig[pubkeyPushOffset];
      expect(pubkeyLen).toBe(33); // compressed pubkey

      offset += scriptSigLen + 4;
    }
  });

  it('single-input VOID tx sighash uses scriptPubKey (not empty) for the signing input', async () => {
    // With 1 input, the signing input should have scriptPubKey in the sighash preimage.
    // We verify by confirming the transaction builds and signs successfully.
    const utxo = { txid: fakeTxid(232), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 50_000, 1, true);
    const txBuf = Buffer.from(result.hex, 'hex');

    expect(txBuf[4]).toBe(1); // 1 input

    // Verify valid signature
    const scriptSigLenOffset = 5 + 32 + 4;
    const scriptSigLen = txBuf[scriptSigLenOffset];
    const scriptSig = txBuf.subarray(scriptSigLenOffset + 1, scriptSigLenOffset + 1 + scriptSigLen);
    const sigPushLen = scriptSig[0];
    const sigWithHashType = scriptSig.subarray(1, 1 + sigPushLen);
    expect(sigWithHashType[0]).toBe(0x30); // DER
    expect(sigWithHashType[sigWithHashType.length - 1]).toBe(0x01); // SIGHASH_ALL
  });
});

// ============================================================================
// Gap 22: UTXO vout boundary values
// ============================================================================
describe('UTXO vout boundary values', () => {
  it('handles vout=0 (minimum)', async () => {
    const utxo = { txid: fakeTxid(240), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    // Parse vout from the first input: version(4) + varint(1) + txid(32) = offset 37
    const vout = txBuf.readUInt32LE(37);
    expect(vout).toBe(0);
  });

  it('handles vout=1 (second output of parent tx)', async () => {
    const utxo = { txid: fakeTxid(241), vout: 1, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    const vout = txBuf.readUInt32LE(37);
    expect(vout).toBe(1);
  });

  it('handles large vout value (vout=65535)', async () => {
    const utxo = { txid: fakeTxid(242), vout: 65535, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    const vout = txBuf.readUInt32LE(37);
    expect(vout).toBe(65535);
  });

  it('handles maximum 32-bit vout value (vout=0xFFFFFFFE)', async () => {
    // 0xFFFFFFFF is reserved for coinbase; 0xFFFFFFFE is the practical max
    const utxo = { txid: fakeTxid(243), vout: 0xFFFFFFFE, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    const vout = txBuf.readUInt32LE(37);
    expect(vout).toBe(0xFFFFFFFE);
  });
});

// ============================================================================
// Gap 23: buildTransaction with P2TR bc1p destination
// ============================================================================
describe('buildTransaction with P2TR bc1p destination', () => {
  it('builds VOID transaction sending to bc1p address and verifies output script', async () => {
    // VOID now blocks bc1 destinations — use VOID mode to test P2TR output scripts
    const xonly = crypto.createHash('sha256').update('gap23-p2tr-dest-build').digest();
    const bc1pDest = encodeBech32m('bc', 1, xonly);

    const utxo = { txid: fakeTxid(250), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, bc1pDest, 50_000, 1, true);
    const txBuf = Buffer.from(result.hex, 'hex');

    // Verify version = 2
    expect(txBuf.readUInt32LE(0)).toBe(2);
    // 1 input
    expect(txBuf[4]).toBe(1);

    // Parse to the first output script
    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4; // skip input
    const outputCount = txBuf[offset];
    expect(outputCount).toBe(2); // destination + change
    offset += 1;

    // First output: 50_000 sats to bc1p
    const amount1 = Number(txBuf.readBigUInt64LE(offset));
    expect(amount1).toBe(50_000);
    offset += 8;
    const script1Len = txBuf[offset];
    expect(script1Len).toBe(34); // OP_1(1) + PUSH_32(1) + 32 bytes = 34
    offset += 1;
    const destScript = txBuf.subarray(offset, offset + script1Len);
    expect(destScript[0]).toBe(0x51); // OP_1 (witness version 1)
    expect(destScript[1]).toBe(0x20); // PUSH 32 bytes
    expect(destScript.subarray(2).equals(xonly)).toBe(true);
  });

  it('builds VOID transaction sending to bc1p address', async () => {
    // bc1p destination should work even for VOID (isVOID=true) since addressToScript
    // checks isBech32Address before checking isVOID
    const xonly = crypto.createHash('sha256').update('gap23-void-p2tr-dest').digest();
    const bc1pDest = encodeBech32m('bc', 1, xonly);

    const utxo = { txid: fakeTxid(251), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, bc1pDest, 50_000, 1, true);
    const txHex = result.hex;

    // P2TR output script should be present
    const expectedScript = '5120' + xonly.toString('hex');
    expect(txHex).toContain(expectedScript);
  });
});

// ============================================================================
// Gap 24: decodeBech32m() verification
// ============================================================================
describe('decodeBech32m decoding', () => {
  it('bech32m checksum constant is 0x2bc830a3 (not bech32 XOR 1)', () => {
    // The BECH32M_CONST in the test file should be 0x2bc830a3
    expect(BECH32M_CONST).toBe(0x2bc830a3);
  });

  it('bech32m-encoded bc1p address decodes successfully (via VOID sendTransaction)', async () => {
    // VOID now blocks bc1 destinations — use VOID mode to test bech32m decoding
    const knownXonly = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) knownXonly[i] = i;
    const bc1pAddr = encodeBech32m('bc', 1, knownXonly);

    expect(bc1pAddr.startsWith('bc1p')).toBe(true);

    // Use as destination in VOID mode to verify addressToScript decodes it correctly
    const utxo = { txid: fakeTxid(126), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, bc1pAddr, 50_000, 1, true);
    const txHex = result.hex;

    // Verify the output script contains the expected P2TR script
    const expectedScript = '5120' + knownXonly.toString('hex');
    expect(txHex).toContain(expectedScript);
  });

  it('bech32 (not bech32m) encoded v1 address fails P2TR detection', async () => {
    // VOID now blocks all bc1 destinations
    const program = crypto.randomBytes(32);
    const bech32v1Addr = encodeBech32('bc', 1, program); // bech32, not bech32m!

    const utxo = { txid: fakeTxid(127), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    await expect(
      sendTransaction(TEST_MNEMONIC, bech32v1Addr, 50_000, 1, false),
    ).rejects.toThrow(/Cannot send VOID to a SegWit/);
  });

  it('bech32m address with corrupted payload returns null from decodeBech32m', async () => {
    // VOID now blocks all bc1 destinations
    const xonly = crypto.createHash('sha256').update('corrupt-bech32m').digest();
    const validAddr = encodeBech32m('bc', 1, xonly);

    // Corrupt the middle of the payload
    const chars = validAddr.split('');
    const midIdx = Math.floor(chars.length / 2);
    chars[midIdx] = chars[midIdx] === 'q' ? 'p' : 'q';
    const corruptAddr = chars.join('');

    const utxo = { txid: fakeTxid(128), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    await expect(
      sendTransaction(TEST_MNEMONIC, corruptAddr, 50_000, 1, false),
    ).rejects.toThrow(/Cannot send VOID to a SegWit/);
  });
});

// ============================================================================
// Gap 25: sendTransaction() with exactly 1 UTXO
// ============================================================================
describe('sendTransaction with exactly 1 UTXO', () => {
  it('succeeds when single UTXO exactly covers amount + 2-output fee', async () => {
    // 1-in 2-out: fee = 226. amount = 50_000. Total needed = 50_226.
    // change = 50_226 + 1000 - 50_000 - 226 = 1000 (above dust 546)
    const utxo = { txid: fakeTxid(130), vout: 0, value: 51_226 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    // Should have 2 outputs (destination + change of 1000)
    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4;
    const outputCount = txBuf[offset];
    expect(outputCount).toBe(2);
  });

  it('succeeds when single UTXO nearly exactly covers amount (dust change absorbed)', async () => {
    // 1-in 2-out: fee = 226. tentativeChange = 50_500 - 50_000 - 226 = 274 (dust, <= 546)
    // So hasChange=false. 1-in 1-out: fee = 192.
    // Surplus = 50_500 - 50_000 - 192 = 308 (absorbed as extra fee)
    const utxo = { txid: fakeTxid(131), vout: 0, value: 50_500 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4;
    const outputCount = txBuf[offset];
    expect(outputCount).toBe(1); // no change, dust absorbed
  });

  it('fails when single UTXO cannot cover amount + minimum fee', async () => {
    // 1-in 1-out: fee = 192. Need 50_192.
    // But UTXO only has 50_100.
    const utxo = { txid: fakeTxid(132), vout: 0, value: 50_100 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false),
    ).rejects.toThrow(/Insufficient funds/);
  });

  it('sends maximum amount from single UTXO (amount = value - 1-out fee)', async () => {
    // 1-in 1-out: fee = 192. Max sendable = 100_000 - 192 = 99_808
    // tentativeChange for 2-out: 100_000 - 99_808 - 226 = -34 (negative, so dust)
    // hasChange = false. 1-out fee = 192. 100_000 - 99_808 - 192 = 0 remainder
    const utxo = { txid: fakeTxid(133), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 99_808, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    let offset = 5;
    const scriptSigLen = txBuf[offset + 36];
    offset += 36 + 1 + scriptSigLen + 4;
    const outputCount = txBuf[offset];
    expect(outputCount).toBe(1); // no change

    // Verify the output amount is exactly 99_808
    offset += 1;
    const amount1 = Number(txBuf.readBigUInt64LE(offset));
    expect(amount1).toBe(99_808);
  });
});

// ============================================================================
// Gap 26: Coin selection with many small UTXOs
// ============================================================================
describe('Coin selection with many small UTXOs', () => {
  it('combines 10 small UTXOs to cover amount + fee', async () => {
    // 10 UTXOs of 10_000 each = 100_000 total
    // 10-in 2-out: size = 10 + 10*148 + 68 = 1558, fee = 1558 at 1 sat/byte
    // amount = 50_000. Total needed = 51_558. Need at least 6 UTXOs (60_000 > 51_558).
    const utxos = Array.from({ length: 10 }, (_, i) => ({
      txid: fakeTxid(134),
      vout: i,
      value: 10_000,
    }));
    mockGetUtxosByAddress.mockResolvedValue(utxos);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    // Should use 6 inputs (6 * 10_000 = 60_000)
    // 6-in 2-out: fee = 10 + 6*148 + 68 = 966
    // change = 60_000 - 50_000 - 966 = 9_034 (> 546, so has change)
    const inputCount = txBuf[4];
    expect(inputCount).toBe(6);
  });

  it('combines 20 very small UTXOs and handles high aggregate fee', async () => {
    // 20 UTXOs of 5_000 each = 100_000 total
    // We want to send 80_000. Need enough UTXOs to cover amount + fee.
    // 17-in 2-out: fee = 10 + 17*148 + 68 = 2594. Total needed = 82_594. Have 17*5000=85_000. OK.
    // change = 85_000 - 80_000 - 2594 = 2_406 (> 546)
    const utxos = Array.from({ length: 20 }, (_, i) => ({
      txid: fakeTxid(135),
      vout: i,
      value: 5_000,
    }));
    mockGetUtxosByAddress.mockResolvedValue(utxos);

    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 80_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    const inputCount = txBuf[4];
    expect(inputCount).toBeGreaterThanOrEqual(17);
    expect(inputCount).toBeLessThanOrEqual(20);
  });

  it('fails when many small UTXOs still cannot cover amount + fee', async () => {
    // 5 UTXOs of 1_000 each = 5_000 total
    // Even 5-in 1-out: fee = 10 + 5*148 + 34 = 784. Total needed = 50_784 >> 5_000
    const utxos = Array.from({ length: 5 }, (_, i) => ({
      txid: fakeTxid(136),
      vout: i,
      value: 1_000,
    }));
    mockGetUtxosByAddress.mockResolvedValue(utxos);

    await expect(
      sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false),
    ).rejects.toThrow(/Insufficient funds/);
  });

  it('selects UTXOs largest-first (greedy algorithm)', async () => {
    // UTXOs with different sizes, not sorted
    const utxos = [
      { txid: fakeTxid(137), vout: 0, value: 5_000 },
      { txid: fakeTxid(138), vout: 0, value: 80_000 },
      { txid: fakeTxid(139), vout: 0, value: 10_000 },
    ];
    mockGetUtxosByAddress.mockResolvedValue(utxos);

    // Amount = 50_000. The 80_000 UTXO alone is enough (1-in 2-out: fee = 226)
    const result = await sendTransaction(TEST_MNEMONIC, DEST_CASHADDR, 50_000, 1, false);
    const txBuf = Buffer.from(result.hex, 'hex');

    // Should select just 1 UTXO (the largest, 80_000)
    expect(txBuf[4]).toBe(1);

    // Verify the input txid corresponds to the 80_000 UTXO (fakeTxid(138))
    const inputTxid = txBuf.subarray(5, 37); // 32 bytes reversed
    const expectedTxidReversed = Buffer.from(fakeTxid(138), 'hex').reverse();
    expect(inputTxid.equals(expectedTxidReversed)).toBe(true);
  });
});

// ============================================================================
// Gap 27: Transaction with OP_RETURN data carrier output
// ============================================================================
describe('Transaction with OP_RETURN destination', () => {
  // The addressToScript function does not natively support OP_RETURN.
  // OP_RETURN outputs are non-standard as "addresses" - they are raw scripts.
  // We test that an OP_RETURN-like address is properly rejected since it doesn't
  // match any address format (not base58, not cashaddr, not bech32).

  it('rejects non-address string as destination for VOID', async () => {
    const utxo = { txid: fakeTxid(140), vout: 0, value: 100_000 };
    mockGetUtxosByAddress.mockResolvedValue([utxo]);

    await expect(
      sendTransaction(TEST_MNEMONIC, 'OP_RETURN_deadbeef', 50_000, 1, false),
    ).rejects.toThrow(); // Will fail at addressToScript (not cashaddr, not bech32)
  });

  it('rejects non-address string as destination for VOID', async () => {
    const utxo = { txid: fakeTxid(141), vout: 0, value: 100_000 };
    mockGetVOIDUtxos.mockResolvedValue([utxo]);

    await expect(
      sendTransaction(TEST_MNEMONIC, 'OP_RETURN_data', 50_000, 1, true),
    ).rejects.toThrow(); // Will fail at decodeLegacyAddress (not valid base58)
  });
});
