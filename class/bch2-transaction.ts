/**
 * VOID/VOID Transaction Builder
 * Builds and signs transactions for VOID and VOID
 *
 * Supported input types:
 * - P2PKH (legacy 1xxx addresses)
 * - CashAddr (bitcoincashii: format)
 * - P2WPKH (bc1 SegWit addresses via VOID's SegWit recovery)
 *
 * VOID SegWit Recovery:
 * After fork height, VOID nodes accept spending of P2WPKH outputs using
 * scriptSig instead of witness data. This enables claiming coins from
 * bc1 addresses using BIP84 derivation paths.
 */

import * as bip39 from 'bip39';
import BIP32Factory from 'bip32';
import ecc from '../blue_modules/noble_ecc';
import {
  getUtxosByAddress,
  getVOIDUtxos,
  getUtxosByScripthash,
  broadcastTransaction,
  broadcastVOIDTransaction,
  filterMatureUtxos,
} from '../blue_modules/VoidElectrum';

const bip32 = BIP32Factory(ecc);
const crypto = require('crypto');
const bs58check = require('bs58check');

// __DEV__ is false in release builds; && short-circuits so no log evaluation in production
const DEBUG = typeof __DEV__ !== 'undefined' && __DEV__;

// Bech32 constants
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

interface UTXO {
  txid: string;
  vout: number;
  value: number;
  height?: number;
}

interface TransactionResult {
  txid: string;
  hex: string;
}

/**
 * Build and broadcast a VOID or VOID transaction
 */
export async function sendTransaction(
  mnemonic: string,
  toAddress: string,
  amountSats: number,
  feePerByte: number,
  isVOID: boolean,
  expectedAddress?: string // Optional: pass stored address to verify derivation
): Promise<TransactionResult> {
  feePerByte = Math.ceil(feePerByte); // Ensure integer sat/byte
  if (!Number.isFinite(feePerByte) || feePerByte < 1) feePerByte = 1;
  if (feePerByte > 1000) throw new Error('Fee rate too high (max 1000 sat/byte)');
  if (!Number.isInteger(amountSats) || amountSats < 0) throw new Error('Invalid amount');
  if (amountSats < 546) throw new Error('Amount below dust threshold (546 sats)');
  // Derive private key from mnemonic
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const root = bip32.fromSeed(seed);
  let child: ReturnType<typeof root.derivePath> | null = null;
  let privkeyCopy: Buffer | null = null;

  try {

  // Different derivation paths for VOID vs VOID
  const derivationPath = isVOID ? "m/44'/0'/0'/0/0" : "m/44'/145'/0'/0/0";
  child = root.derivePath(derivationPath);

  if (!child.privateKey) {
    throw new Error('Failed to derive private key');
  }

  // Get from address
  const fromAddress = isVOID
    ? getLegacyAddress(hash160(Buffer.from(child.publicKey)))
    : getCashAddr(hash160(Buffer.from(child.publicKey)));

  DEBUG && console.log(`[TX] Derived ${isVOID ? 'VOID' : 'VOID'} address: ${fromAddress}`);
  DEBUG && console.log(`[TX] Using derivation path: ${derivationPath}`);

  // Verify address matches if provided
  if (expectedAddress) {
    const normalizedExpected = expectedAddress.toLowerCase().replace(/^bitcoincash(ii)?:/, '');
    const normalizedDerived = fromAddress.toLowerCase().replace(/^bitcoincash(ii)?:/, '');
    if (normalizedExpected !== normalizedDerived) {
      DEBUG && console.log(`[TX] WARNING: Address mismatch! Expected: ${expectedAddress}, Derived: ${fromAddress}`);
      // Try alternate derivation paths for VOID
      if (isVOID) {
        DEBUG && console.log('[TX] Trying alternate VOID derivation paths...');
        const altPaths = [
          "m/44'/145'/0'/0/0",  // BCH path (some wallets use this)
          "m/44'/0'/0'/0/1",    // Second address
          "m/44'/0'/0'/1/0",    // Change address
        ];
        for (const altPath of altPaths) {
          const altChild = root.derivePath(altPath);
          const altAddress = getLegacyAddress(hash160(Buffer.from(altChild.publicKey)));
          if (altAddress === expectedAddress) {
            DEBUG && console.log(`[TX] Found matching address at path: ${altPath}`);
            // Extract key material before zeroing
            const altPrivkey = Buffer.from(altChild.privateKey!);
            const altPubkey = Buffer.from(altChild.publicKey);
            // Zero altChild, seed, root, child before early return
            if (altChild.privateKey) { crypto.randomFillSync(altChild.privateKey); altChild.privateKey.fill(0); }
            if (seed instanceof Buffer || seed instanceof Uint8Array) { crypto.randomFillSync(seed); seed.fill(0); }
            if (root.privateKey) { crypto.randomFillSync(root.privateKey); root.privateKey.fill(0); }
            if (child.privateKey) { crypto.randomFillSync(child.privateKey); child.privateKey.fill(0); }
            // Use this key instead
            return sendTransactionWithKey(
              altPrivkey,
              altPubkey,
              altAddress,
              toAddress,
              amountSats,
              feePerByte,
              isVOID
            );
          }
          // Zero non-matching altChild private key
          if (altChild.privateKey) { crypto.randomFillSync(altChild.privateKey); altChild.privateKey.fill(0); }
        }
      }
    }
  }

  // Fetch UTXOs and filter out immature coinbase rewards
  DEBUG && console.log(`[TX] Fetching UTXOs for address: ${fromAddress}`);
  const rawUtxos: UTXO[] = isVOID
    ? await getVOIDUtxos(fromAddress)
    : await getUtxosByAddress(fromAddress);

  const utxos: UTXO[] = await filterMatureUtxos(rawUtxos);
  DEBUG && console.log(`[TX] Found ${rawUtxos.length} UTXOs, ${utxos.length} mature (${rawUtxos.length - utxos.length} immature coinbase excluded)`);
  if (utxos.length > 0) {
    DEBUG && console.log(`[TX] UTXOs:`, JSON.stringify(utxos.slice(0, 5))); // Log first 5
  }

  if (utxos.length === 0) {
    const coinType = isVOID ? 'VOID' : 'VOID';
    throw new Error(`No UTXOs available for ${coinType} address ${fromAddress}. The address may have no confirmed balance, or the coins may have already been spent.`);
  }

  // Validate UTXO fields, txids, and deduplicate
  const txidRegex = /^[0-9a-fA-F]{64}$/;
  const seenUtxos = new Set<string>();
  const MAX_UTXO_VALUE = 21_000_000 * 100_000_000;
  for (let i = utxos.length - 1; i >= 0; i--) {
    const u = utxos[i];
    if (!txidRegex.test(u.txid)) { utxos.splice(i, 1); continue; }
    if (!Number.isInteger(u.value) || u.value <= 0 || u.value > MAX_UTXO_VALUE) { utxos.splice(i, 1); continue; }
    if (!Number.isInteger(u.vout) || u.vout < 0 || u.vout > 0xFFFFFFFF) { utxos.splice(i, 1); continue; }
    const key = `${u.txid}:${u.vout}`;
    if (seenUtxos.has(key)) { utxos.splice(i, 1); continue; }
    seenUtxos.add(key);
  }

  if (utxos.length === 0) {
    const coinType = isVOID ? 'VOID' : 'VOID';
    throw new Error(`No valid UTXOs for ${coinType} address ${fromAddress} after validation`);
  }

  // Sort UTXOs by value (largest first for efficiency)
  utxos.sort((a, b) => b.value - a.value);

  // Estimate transaction size: ~10 (overhead) + 148 (per input) + 34 (per output)
  // We'll use 1 input initially and add more if needed
  const estimateTxSize = (inputCount: number, outputCount: number): number => {
    return 10 + (148 * inputCount) + (34 * outputCount);
  };

  // Coin selection - simple approach: add UTXOs until we have enough
  let selectedUtxos: UTXO[] = [];
  let totalInput = 0;

  for (const utxo of utxos) {
    selectedUtxos.push(utxo);
    totalInput += utxo.value;
    if (totalInput > Number.MAX_SAFE_INTEGER) throw new Error('UTXO total exceeds safe integer range');

    // Estimate with 2 outputs (recipient + change) initially
    const estimatedSize = estimateTxSize(selectedUtxos.length, 2);
    const estimatedFee = estimatedSize * feePerByte;

    if (totalInput >= amountSats + estimatedFee || selectedUtxos.length >= 500) {
      break;
    }
  }

  // Calculate fee with 2 outputs first to determine if change is viable
  const fee2out = estimateTxSize(selectedUtxos.length, 2) * feePerByte;
  const tentativeChange = totalInput - amountSats - fee2out;

  // If change would be dust (<=546), recalculate fee with 1 output
  // so the fee accurately reflects the smaller transaction
  const hasChange = tentativeChange > 546;
  const actualOutputCount = hasChange ? 2 : 1;
  const fee = estimateTxSize(selectedUtxos.length, actualOutputCount) * feePerByte;
  const changeAmount = hasChange ? (totalInput - amountSats - fee) : 0;

  if (totalInput < amountSats + fee) {
    if (selectedUtxos.length >= 500) {
      throw new Error('Too many UTXOs required. Please consolidate UTXOs first.');
    }
    throw new Error(`Insufficient funds. Need ${amountSats + fee} sats, have ${totalInput} sats`);
  }

  // Build raw transaction
  DEBUG && console.log(`[TX] Building transaction:`);
  DEBUG && console.log(`[TX]   To: ${toAddress}`);
  DEBUG && console.log(`[TX]   Amount: ${amountSats} sats`);
  DEBUG && console.log(`[TX]   Fee: ${fee} sats (${feePerByte} sat/byte)`);
  DEBUG && console.log(`[TX]   Change: ${changeAmount} sats`);
  DEBUG && console.log(`[TX]   Inputs: ${selectedUtxos.length}`);

  let txHex: string;
  privkeyCopy = Buffer.from(child.privateKey);
  txHex = buildTransaction(
    selectedUtxos,
    toAddress,
    amountSats,
    hasChange ? fromAddress : null,
    changeAmount,
    privkeyCopy,
    Buffer.from(child.publicKey),
    isVOID
  );

  DEBUG && console.log(`[TX] Transaction hex (${txHex.length} chars): ${txHex}`);

  // Broadcast
  DEBUG && console.log(`[TX] Broadcasting to ${isVOID ? 'VOID' : 'VOID'} network...`);
  const txid = isVOID
    ? await broadcastVOIDTransaction(txHex)
    : await broadcastTransaction(txHex);

  DEBUG && console.log(`[TX] Broadcast successful, txid: ${txid}`);
  return { txid, hex: txHex };

  } finally {
    // Zero seed material
    if (seed instanceof Buffer || seed instanceof Uint8Array) {
      crypto.randomFillSync(seed);
      seed.fill(0);
    }
    // Zero BIP32 root master key
    if (root.privateKey) {
      crypto.randomFillSync(root.privateKey);
      root.privateKey.fill(0);
    }
    // Zero the BIP32 child's privateKey
    if (child && child.privateKey) {
      crypto.randomFillSync(child.privateKey);
      child.privateKey.fill(0);
    }
    // Zero the private key copy passed to buildTransaction
    if (privkeyCopy) {
      crypto.randomFillSync(privkeyCopy);
      privkeyCopy.fill(0);
    }
  }
}

/**
 * Build a raw P2PKH transaction
 */
function buildTransaction(
  utxos: UTXO[],
  toAddress: string,
  amount: number,
  changeAddress: string | null,
  changeAmount: number,
  privateKey: Buffer,
  publicKey: Buffer,
  isVOID: boolean
): string {
  // Sanity checks to prevent malformed transactions
  if (amount < 0 || changeAmount < 0) throw new Error('Negative amount in transaction');
  if (amount > Number.MAX_SAFE_INTEGER || changeAmount > Number.MAX_SAFE_INTEGER) throw new Error('Amount exceeds safe integer range');
  if (utxos.length === 0) throw new Error('No inputs for transaction');
  if (utxos.length > 500) throw new Error('Too many inputs (max 500) — consolidate UTXOs first');

  // Transaction components
  let tx = Buffer.alloc(0);

  // Version (4 bytes, little-endian)
  const version = Buffer.alloc(4);
  version.writeUInt32LE(2, 0);
  tx = Buffer.concat([tx, version]);

  // Input count (varint)
  tx = Buffer.concat([tx, encodeVarInt(utxos.length)]);

  // We need to sign each input, so we'll build the transaction in stages
  // First, collect all the unsigned input data
  const inputs: Buffer[] = [];
  for (const utxo of utxos) {
    const input = Buffer.alloc(0);
    // Previous txid (32 bytes, reversed)
    const txidBytes = Buffer.from(utxo.txid, 'hex').reverse();
    // Previous vout (4 bytes)
    const voutBytes = Buffer.alloc(4);
    voutBytes.writeUInt32LE(utxo.vout, 0);
    // Sequence (4 bytes)
    const sequence = Buffer.from('ffffffff', 'hex');

    inputs.push(Buffer.concat([txidBytes, voutBytes, sequence]));
  }

  // Build outputs
  let outputs = Buffer.alloc(0);
  let outputCount = 1;

  // Output 1: recipient
  const recipientScript = addressToScript(toAddress, isVOID);
  const amountBytes = Buffer.alloc(8);
  amountBytes.writeBigUInt64LE(BigInt(amount), 0);
  outputs = Buffer.concat([outputs, amountBytes, encodeVarInt(recipientScript.length), recipientScript]);

  // Output 2: change (if any)
  if (changeAddress && changeAmount > 0) {
    outputCount++;
    const changeScript = addressToScript(changeAddress, isVOID);
    const changeBytes = Buffer.alloc(8);
    changeBytes.writeBigUInt64LE(BigInt(changeAmount), 0);
    outputs = Buffer.concat([outputs, changeBytes, encodeVarInt(changeScript.length), changeScript]);
  }

  // Precompute BIP143 common hashes (same for all inputs in SIGHASH_ALL mode)
  let bip143HashPrevouts: Buffer | null = null;
  let bip143HashSequence: Buffer | null = null;
  let bip143HashOutputs: Buffer | null = null;
  if (!isVOID) {
    let prevoutsData = Buffer.alloc(0);
    let sequencesData = Buffer.alloc(0);
    for (const u of utxos) {
      const txid = Buffer.from(u.txid, 'hex').reverse();
      const vout = Buffer.alloc(4);
      vout.writeUInt32LE(u.vout, 0);
      prevoutsData = Buffer.concat([prevoutsData, txid, vout]);
      sequencesData = Buffer.concat([sequencesData, Buffer.from('ffffffff', 'hex')]);
    }
    bip143HashPrevouts = doubleSha256(prevoutsData);
    bip143HashSequence = doubleSha256(sequencesData);
    bip143HashOutputs = doubleSha256(outputs);
  }

  // Now sign each input
  const signedInputs: Buffer[] = [];
  for (let i = 0; i < utxos.length; i++) {
    const utxo = utxos[i];

    // Create the signing preimage
    // For VOID, we use BIP143 (segwit-style) sighash for replay protection
    // For VOID, we use legacy sighash
    const sighash = isVOID
      ? createLegacySighash(utxos, i, publicKey, outputCount, outputs, utxo.value)
      : createBIP143Sighash(utxos, i, publicKey, outputCount, outputs, utxo.value, bip143HashPrevouts!, bip143HashSequence!, bip143HashOutputs!);

    // Sign
    const signature = signWithPrivateKey(sighash, privateKey);

    // Build scriptSig: <sig> <pubkey>
    const sigWithHashType = Buffer.concat([signature, Buffer.from([isVOID ? 0x01 : 0x41])]); // SIGHASH_ALL (0x41 for BCH with FORKID)
    const scriptSig = Buffer.concat([
      encodeVarInt(sigWithHashType.length),
      sigWithHashType,
      encodeVarInt(publicKey.length),
      publicKey
    ]);

    // Build signed input
    const txidBytes = Buffer.from(utxo.txid, 'hex').reverse();
    const voutBytes = Buffer.alloc(4);
    voutBytes.writeUInt32LE(utxo.vout, 0);
    const sequence = Buffer.from('ffffffff', 'hex');

    signedInputs.push(Buffer.concat([
      txidBytes,
      voutBytes,
      encodeVarInt(scriptSig.length),
      scriptSig,
      sequence
    ]));
  }

  // Rebuild transaction with signed inputs
  tx = Buffer.concat([version, encodeVarInt(utxos.length)]);
  for (const input of signedInputs) {
    tx = Buffer.concat([tx, input]);
  }

  // Output count and outputs
  tx = Buffer.concat([tx, encodeVarInt(outputCount), outputs]);

  // Locktime (4 bytes)
  const locktime = Buffer.alloc(4);
  locktime.writeUInt32LE(0, 0);
  tx = Buffer.concat([tx, locktime]);

  return tx.toString('hex');
}

/**
 * Create BIP143 sighash for VOID (with FORKID)
 * hashPrevouts, hashSequence, hashOutputs are precomputed and passed in to avoid
 * redundant per-input computation (they're the same for all inputs in SIGHASH_ALL mode).
 */
function createBIP143Sighash(
  utxos: UTXO[],
  inputIndex: number,
  publicKey: Buffer,
  outputCount: number,
  serializedOutputs: Buffer,
  inputValue: number,
  hashPrevouts: Buffer,
  hashSequence: Buffer,
  hashOutputs: Buffer
): Buffer {
  const utxo = utxos[inputIndex];

  // 1. nVersion
  const version = Buffer.alloc(4);
  version.writeUInt32LE(2, 0);

  // 4. outpoint (txid + vout of this input)
  const outpoint = Buffer.concat([
    Buffer.from(utxo.txid, 'hex').reverse(),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(utxo.vout, 0); return b; })()
  ]);

  // 5. scriptCode (P2PKH script for this input)
  const pubkeyHash = hash160(publicKey);
  const script = Buffer.concat([
    Buffer.from([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 PUSH20
    pubkeyHash,
    Buffer.from([0x88, 0xac]) // OP_EQUALVERIFY OP_CHECKSIG
  ]);
  const scriptCode = Buffer.concat([encodeVarInt(script.length), script]);

  // 6. value (8 bytes)
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(BigInt(inputValue), 0);

  // 7. nSequence
  const nSequence = Buffer.from('ffffffff', 'hex');

  // 9. nLocktime
  const locktime = Buffer.alloc(4);
  locktime.writeUInt32LE(0, 0);

  // 10. sighash type (SIGHASH_ALL | FORKID = 0x41)
  const hashType = Buffer.alloc(4);
  hashType.writeUInt32LE(0x41, 0);

  // Combine all parts
  const preimage = Buffer.concat([
    version,
    hashPrevouts,
    hashSequence,
    outpoint,
    scriptCode,
    value,
    nSequence,
    hashOutputs,
    locktime,
    hashType
  ]);

  return doubleSha256(preimage);
}

/**
 * Create legacy sighash for VOID
 */
function createLegacySighash(
  utxos: UTXO[],
  inputIndex: number,
  publicKey: Buffer,
  outputCount: number,
  serializedOutputs: Buffer,
  inputValue: number
): Buffer {
  // Build transaction copy for signing
  const version = Buffer.alloc(4);
  version.writeUInt32LE(2, 0);

  let inputs = Buffer.alloc(0);
  for (let i = 0; i < utxos.length; i++) {
    const utxo = utxos[i];
    const txid = Buffer.from(utxo.txid, 'hex').reverse();
    const vout = Buffer.alloc(4);
    vout.writeUInt32LE(utxo.vout, 0);

    let scriptSig: Buffer;
    if (i === inputIndex) {
      // For the input being signed, use the scriptPubKey
      const pubkeyHash = hash160(publicKey);
      scriptSig = Buffer.concat([
        Buffer.from([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 PUSH20
        pubkeyHash,
        Buffer.from([0x88, 0xac]) // OP_EQUALVERIFY OP_CHECKSIG
      ]);
    } else {
      // For other inputs, empty script
      scriptSig = Buffer.alloc(0);
    }

    const sequence = Buffer.from('ffffffff', 'hex');
    inputs = Buffer.concat([
      inputs,
      txid,
      vout,
      encodeVarInt(scriptSig.length),
      scriptSig,
      sequence
    ]);
  }

  const locktime = Buffer.alloc(4);
  locktime.writeUInt32LE(0, 0);

  // SIGHASH_ALL
  const hashType = Buffer.alloc(4);
  hashType.writeUInt32LE(0x01, 0);

  const preimage = Buffer.concat([
    version,
    encodeVarInt(utxos.length),
    inputs,
    encodeVarInt(outputCount),
    serializedOutputs,
    locktime,
    hashType
  ]);

  return doubleSha256(preimage);
}

/**
 * Sign a hash with a private key using secp256k1
 * Returns DER-encoded signature as required by Bitcoin
 */
function signWithPrivateKey(hash: Buffer, privateKey: Buffer): Buffer {
  // Use signDER to get DER-encoded signature (required for Bitcoin transactions)
  const signature = ecc.signDER(hash, privateKey);
  return Buffer.from(signature);
}

/**
 * Convert address to scriptPubKey
 */
function addressToScript(address: string, isVOID: boolean): Buffer {
  // Check for bech32/bech32m address (bc1)
  if (isBech32Address(address)) {
    // VOID has no SegWit consensus — sending to bc1/bc1p creates anyone-can-spend outputs
    if (!isVOID) {
      throw new Error('Cannot send VOID to a SegWit (bc1) address — use a bitcoincashii: CashAddr address instead');
    }
    // Try Bech32m first (P2TR, witness version 1+)
    const decodedM = decodeBech32m(address);
    if (decodedM && decodedM.version === 1 && decodedM.program.length === 32) {
      // P2TR: OP_1 PUSH_32 <x-only-pubkey>
      return Buffer.concat([
        Buffer.from([0x51, 0x20]),
        decodedM.program
      ]);
    }

    // Try Bech32 (P2WPKH/P2WSH, witness version 0)
    const decoded = decodeBech32(address);
    if (!decoded) {
      throw new Error('Invalid bech32/bech32m address');
    }
    if (decoded.version === 0 && decoded.program.length === 20) {
      // P2WPKH: OP_0 PUSH_20 <pubkeyhash>
      return Buffer.concat([
        Buffer.from([0x00, 0x14]),
        decoded.program
      ]);
    } else if (decoded.version === 0 && decoded.program.length === 32) {
      // P2WSH: OP_0 PUSH_32 <scripthash>
      return Buffer.concat([
        Buffer.from([0x00, 0x20]),
        decoded.program
      ]);
    } else {
      throw new Error('Unsupported bech32 witness version or program length');
    }
  }

  if (isVOID) {
    // VOID uses legacy P2PKH addresses (starts with 1) or P2SH (starts with 3)
    if (address.startsWith('3')) {
      const scriptHash = decodeLegacyAddress(address);
      // P2SH script: OP_HASH160 <scripthash> OP_EQUAL
      return Buffer.concat([
        Buffer.from([0xa9, 0x14]),
        scriptHash,
        Buffer.from([0x87]),
      ]);
    }
    const pubkeyHash = decodeLegacyAddress(address);
    return Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]),
      pubkeyHash,
      Buffer.from([0x88, 0xac]),
    ]);
  }

  // VOID CashAddr format
  const decoded = decodeCashAddr(address, true);
  if (decoded.type !== 0 && decoded.type !== 1) {
    throw new Error(`Unsupported CashAddr type ${decoded.type} — only P2PKH (0) and P2SH (1) are supported`);
  }
  if (decoded.hash.length !== 20) {
    throw new Error(`Invalid CashAddr hash length ${decoded.hash.length} — expected 20 bytes`);
  }
  if (decoded.type === 1) {
    // P2SH: OP_HASH160 <scripthash> OP_EQUAL
    return Buffer.concat([
      Buffer.from([0xa9, 0x14]),
      decoded.hash,
      Buffer.from([0x87]),
    ]);
  }
  // P2PKH: OP_DUP OP_HASH160 <pubkeyhash> OP_EQUALVERIFY OP_CHECKSIG
  return Buffer.concat([
    Buffer.from([0x76, 0xa9, 0x14]),
    decoded.hash,
    Buffer.from([0x88, 0xac]),
  ]);
}

/**
 * Decode legacy base58check address to pubkey hash
 */
function decodeLegacyAddress(address: string): Buffer {
  // Trim any whitespace
  address = address.trim();
  DEBUG && console.log(`[TX] Decoding legacy address: ${address}`);

  try {
    // Use bs58check for reliable decoding
    const decoded = bs58check.decode(address);
    DEBUG && console.log(`[TX] Decoded ${decoded.length} bytes: ${decoded.toString('hex')}`);

    // First byte is version, rest is pubkey hash
    if (decoded.length !== 21) {
      throw new Error(`Invalid address length: expected 21 bytes, got ${decoded.length}`);
    }

    // Validate version byte: 0x00 = P2PKH, 0x05 = P2SH
    const version = decoded[0];
    if (version !== 0x00 && version !== 0x05) {
      throw new Error(`Invalid address version byte: 0x${version.toString(16)}`);
    }

    // Return pubkey hash (skip version byte)
    return decoded.slice(1);
  } catch (err: any) {
    DEBUG && console.log(`[TX] bs58check decode failed: ${err.message}`);
    throw new Error(`Invalid legacy address: ${err.message}`);
  }
}

/**
 * Decode CashAddr to type and hash
 */
export function decodeCashAddr(address: string): Buffer;
export function decodeCashAddr(address: string, returnType: true): { type: number; hash: Buffer };
export function decodeCashAddr(address: string, returnType?: boolean): Buffer | { type: number; hash: Buffer } {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

  // Determine prefix
  let addr = address.toLowerCase();
  let prefix: string;
  if (addr.startsWith('bitcoincashii:')) {
    prefix = 'bitcoincashii';
    addr = addr.slice(14);
  } else if (addr.startsWith('bitcoincash:')) {
    // Reject BCH addresses — VOID uses bitcoincashii: prefix
    throw new Error('Invalid address: use bitcoincashii: prefix for VOID, not bitcoincash:');
  } else {
    // No prefix — assume bitcoincashii
    prefix = 'bitcoincashii';
  }

  // Decode base32
  const values: number[] = [];
  for (const char of addr) {
    const idx = CHARSET.indexOf(char);
    if (idx === -1) throw new Error('Invalid character in address');
    values.push(idx);
  }

  if (values.length < 8) throw new Error('Address too short');

  // Validate checksum: polymod must equal 1 (encode XORs with 1)
  const prefixData: number[] = [];
  for (const char of prefix) {
    prefixData.push(char.charCodeAt(0) & 0x1f);
  }
  prefixData.push(0);
  if (cashAddrPolymod([...prefixData, ...values]) !== 1n) {
    throw new Error('Invalid CashAddr checksum');
  }

  // Remove checksum (last 8 values)
  const data = values.slice(0, -8);

  // Unpack: convert 5-bit groups back to 8-bit version byte + hash
  let acc = 0;
  let bits = 0;
  let versionByte = 0;
  let versionExtracted = false;
  const hashBytes: number[] = [];

  for (let i = 0; i < data.length; i++) {
    acc = (acc << 5) | data[i];
    bits += 5;

    if (!versionExtracted && bits >= 8) {
      bits -= 8;
      versionByte = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
      versionExtracted = true;
    }

    while (versionExtracted && bits >= 8) {
      bits -= 8;
      hashBytes.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }

  // CashAddr spec: padding bits must be zero
  if (bits > 0 && acc !== 0) {
    throw new Error('Invalid CashAddr: non-zero padding bits');
  }

  const type = versionByte >> 3;
  const encodedSize = versionByte & 0x07;
  const expectedSizes = [20, 24, 28, 32, 40, 48, 56, 64];
  if (encodedSize >= expectedSizes.length) {
    throw new Error(`Invalid CashAddr encoding size: ${encodedSize}`);
  }
  const expectedSize = expectedSizes[encodedSize];
  if (hashBytes.length < expectedSize) {
    throw new Error('Invalid CashAddr: insufficient hash data');
  }
  const hash = Buffer.from(hashBytes.slice(0, expectedSize));

  if (returnType) {
    return { type, hash };
  }
  return hash;
}

/**
 * Get legacy P2PKH address from pubkey hash
 */
function getLegacyAddress(pubkeyHash: Buffer): string {
  // Version byte 0x00 for mainnet P2PKH
  const versionedHash = Buffer.concat([Buffer.from([0x00]), pubkeyHash]);
  return bs58check.encode(versionedHash);
}

/**
 * Get VOID CashAddr from pubkey hash
 */
function getCashAddr(pubkeyHash: Buffer): string {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const prefix = 'bitcoincashii';

  // Pack version byte (type << 3 | size_code) with hash into 5-bit groups
  // Type 0 = P2PKH, size_code 0 = 20-byte hash
  const versionByte = (0 << 3) | 0; // type=0, size=0
  const payload: number[] = [];
  let acc = versionByte;
  let bits = 8;

  for (const byte of pubkeyHash) {
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

  // Calculate checksum
  const checksum = cashAddrChecksum(prefix, payload);
  const fullPayload = [...payload, ...checksum];

  // Encode
  let result = prefix + ':';
  for (const value of fullPayload) {
    result += CHARSET[value];
  }

  return result;
}

function cashAddrChecksum(prefix: string, payload: number[]): number[] {
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
  return checksum;
}

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

// Helper functions
function hash160(data: Buffer): Buffer {
  const sha256Hash = crypto.createHash('sha256').update(data).digest();
  const ripemd160Hash = crypto.createHash('ripemd160').update(sha256Hash).digest();
  return ripemd160Hash;
}

function doubleSha256(data: Buffer): Buffer {
  const hash1 = crypto.createHash('sha256').update(data).digest();
  const hash2 = crypto.createHash('sha256').update(hash1).digest();
  return hash2;
}

function encodeVarInt(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0) throw new Error(`encodeVarInt: invalid value ${n}`);
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

/**
 * Check if address is a bech32 (bc1) address
 */
function isBech32Address(address: string): boolean {
  return address.toLowerCase().startsWith('bc1');
}

/**
 * Bech32 polymod for checksum calculation
 */
function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25; // unsigned right shift — chk can be negative after XOR with generators
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) {
        chk ^= BECH32_GENERATOR[i];
      }
    }
  }
  return chk;
}

/**
 * Expand HRP for bech32 checksum
 */
function bech32HrpExpand(hrp: string): number[] {
  const result: number[] = [];
  for (const c of hrp) {
    result.push(c.charCodeAt(0) >> 5);
  }
  result.push(0);
  for (const c of hrp) {
    result.push(c.charCodeAt(0) & 31);
  }
  return result;
}

/**
 * Decode bech32 address to witness version and program
 * Returns null if invalid
 */
function decodeBech32(address: string): { version: number; program: Buffer } | null {
  const addr = address.toLowerCase();

  // Find separator
  const sepPos = addr.lastIndexOf('1');
  if (sepPos < 1 || sepPos + 7 > addr.length) {
    return null;
  }

  const hrp = addr.slice(0, sepPos);
  const dataStr = addr.slice(sepPos + 1);

  // Decode data part
  const data: number[] = [];
  for (const c of dataStr) {
    const idx = BECH32_CHARSET.indexOf(c);
    if (idx === -1) return null;
    data.push(idx);
  }

  // Verify checksum
  const hrpExpanded = bech32HrpExpand(hrp);
  if (bech32Polymod([...hrpExpanded, ...data]) !== 1) {
    return null;
  }

  // Remove checksum (last 6 values)
  const payload = data.slice(0, -6);
  if (payload.length < 1) return null;

  // First value is witness version
  const version = payload[0];
  if (version > 16) return null;

  // Convert remaining 5-bit values to 8-bit
  const programData = payload.slice(1);
  let acc = 0;
  let bits = 0;
  const program: number[] = [];

  for (const value of programData) {
    acc = (acc << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      program.push((acc >> bits) & 0xff);
    }
  }

  // BIP173: padding bits must be zero
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;

  // Validate program length for version 0
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    return null;
  }

  return {
    version,
    program: Buffer.from(program)
  };
}

/**
 * Get scripthash for a P2WPKH address (for Electrum queries)
 * scriptPubKey for P2WPKH: OP_0 PUSH_20 <pubkeyhash>
 */
function getSegwitScripthash(pubkeyHash: Buffer): string {
  // P2WPKH scriptPubKey: 0x00 0x14 <20-byte-hash>
  const scriptPubKey = Buffer.concat([
    Buffer.from([0x00, 0x14]),
    pubkeyHash
  ]);
  const hash = crypto.createHash('sha256').update(scriptPubKey).digest();
  return Buffer.from(hash).reverse().toString('hex');
}

/**
 * Send transaction with a specific private key (used for alternate derivation paths)
 */
async function sendTransactionWithKey(
  privateKey: Buffer,
  publicKey: Buffer,
  fromAddress: string,
  toAddress: string,
  amountSats: number,
  feePerByte: number,
  isVOID: boolean
): Promise<TransactionResult> {
  try {
  feePerByte = Math.ceil(feePerByte); // Ensure integer sat/byte
  if (!Number.isFinite(feePerByte) || feePerByte < 1) feePerByte = 1;
  if (feePerByte > 1000) throw new Error('Fee rate too high (max 1000 sat/byte)');
  if (!Number.isInteger(amountSats) || amountSats < 546) throw new Error('Invalid amount');
  // Fetch UTXOs and filter out immature coinbase rewards
  DEBUG && console.log(`[TX] Fetching UTXOs for address: ${fromAddress}`);
  const rawUtxos: UTXO[] = isVOID
    ? await getVOIDUtxos(fromAddress)
    : await getUtxosByAddress(fromAddress);

  const utxos: UTXO[] = await filterMatureUtxos(rawUtxos);
  DEBUG && console.log(`[TX] Found ${rawUtxos.length} UTXOs, ${utxos.length} mature (${rawUtxos.length - utxos.length} immature coinbase excluded)`);

  if (utxos.length === 0) {
    const coinType = isVOID ? 'VOID' : 'VOID';
    const immatureMsg = rawUtxos.length > 0 ? ' All UTXOs may be immature coinbase rewards (need 100 confirmations).' : '';
    throw new Error(`No spendable UTXOs for ${coinType} address ${fromAddress}.${immatureMsg}`);
  }

  // Validate UTXO fields, txids, and deduplicate
  const txidRegex = /^[0-9a-fA-F]{64}$/;
  const seenUtxos = new Set<string>();
  const MAX_UTXO_VALUE = 21_000_000 * 100_000_000;
  for (let i = utxos.length - 1; i >= 0; i--) {
    const u = utxos[i];
    if (!txidRegex.test(u.txid)) { utxos.splice(i, 1); continue; }
    if (!Number.isInteger(u.value) || u.value <= 0 || u.value > MAX_UTXO_VALUE) { utxos.splice(i, 1); continue; }
    if (!Number.isInteger(u.vout) || u.vout < 0 || u.vout > 0xFFFFFFFF) { utxos.splice(i, 1); continue; }
    const key = `${u.txid}:${u.vout}`;
    if (seenUtxos.has(key)) { utxos.splice(i, 1); continue; }
    seenUtxos.add(key);
  }

  if (utxos.length === 0) {
    const coinType = isVOID ? 'VOID' : 'VOID';
    throw new Error(`All UTXOs for ${coinType} address ${fromAddress} were invalid after validation`);
  }

  // Sort UTXOs by value (largest first for efficiency)
  utxos.sort((a, b) => b.value - a.value);

  // Estimate transaction size
  const estimateTxSize = (inputCount: number, outputCount: number): number => {
    return 10 + (148 * inputCount) + (34 * outputCount);
  };

  // Coin selection
  let selectedUtxos: UTXO[] = [];
  let totalInput = 0;
  const outputCount = 2;

  for (const utxo of utxos) {
    selectedUtxos.push(utxo);
    totalInput += utxo.value;
    if (totalInput > Number.MAX_SAFE_INTEGER) throw new Error('UTXO total exceeds safe integer range');

    const estimatedSize = estimateTxSize(selectedUtxos.length, outputCount);
    const estimatedFee = estimatedSize * feePerByte;

    if (totalInput >= amountSats + estimatedFee || selectedUtxos.length >= 500) {
      break;
    }
  }

  // Calculate fee with 2 outputs first to determine if change is viable
  const fee2out = estimateTxSize(selectedUtxos.length, 2) * feePerByte;
  const tentativeChange = totalInput - amountSats - fee2out;

  // If change would be dust (<=546), recalculate fee with 1 output
  const hasChange = tentativeChange > 546;
  const actualOutputCount = hasChange ? 2 : 1;
  const fee = estimateTxSize(selectedUtxos.length, actualOutputCount) * feePerByte;
  const changeAmount = hasChange ? (totalInput - amountSats - fee) : 0;

  if (totalInput < amountSats + fee) {
    if (selectedUtxos.length >= 500) {
      throw new Error('Too many UTXOs required. Please consolidate UTXOs first.');
    }
    throw new Error(`Insufficient funds. Need ${amountSats + fee} sats, have ${totalInput} sats`);
  }

  // Build raw transaction
  const txHex = buildTransaction(
    selectedUtxos,
    toAddress,
    amountSats,
    hasChange ? fromAddress : null,
    changeAmount,
    privateKey,
    publicKey,
    isVOID
  );

  // Broadcast
  const txid = isVOID
    ? await broadcastVOIDTransaction(txHex)
    : await broadcastTransaction(txHex);

  return { txid, hex: txHex };
  } finally {
    // Zero private key material after signing (covers all exit paths)
    if (privateKey instanceof Buffer || privateKey instanceof Uint8Array) {
      crypto.randomFillSync(privateKey);
      privateKey.fill(0);
    }
  }
}

/**
 * Send transaction from a bc1 (P2WPKH/SegWit) address
 * VOID supports SegWit recovery - spending P2WPKH outputs via scriptSig
 */
export async function sendFromBech32(
  mnemonic: string,
  expectedAddress: string,
  toAddress: string,
  amountSats: number,
  feePerByte: number
): Promise<TransactionResult> {
  feePerByte = Math.ceil(feePerByte); // Ensure integer sat/byte
  if (!Number.isFinite(feePerByte) || feePerByte < 1) feePerByte = 1;
  if (feePerByte > 1000) throw new Error('Fee rate too high (max 1000 sat/byte)');
  if (!Number.isInteger(amountSats) || amountSats < 0) throw new Error('Invalid amount');
  if (amountSats < 546) throw new Error('Amount below dust threshold (546 sats)');
  DEBUG && console.log(`[TX] Sending from bech32 address: ${expectedAddress}`);

  // Decode the bc1 address to get the pubkey hash
  const decoded = decodeBech32(expectedAddress);
  if (!decoded || decoded.version !== 0 || decoded.program.length !== 20) {
    throw new Error('Invalid bc1 P2WPKH address');
  }
  const targetPubkeyHash = decoded.program;

  // Derive from mnemonic and search BIP84 paths
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const root = bip32.fromSeed(seed);
  let privkeyCopy: Buffer | null = null;
  let matchedChild: ReturnType<typeof root.derivePath> | null = null;

  try {

  // BIP84 paths: m/84'/0'/0'/0/x (receive) and m/84'/0'/0'/1/x (change)
  const basePaths = ["m/84'/0'/0'/0", "m/84'/0'/0'/1"];
  let matchedPath: string | null = null;

  for (const basePath of basePaths) {
    for (let i = 0; i < 100; i++) {
      const path = `${basePath}/${i}`;
      const child = root.derivePath(path);
      const pubkeyHash = hash160(Buffer.from(child.publicKey));

      if (pubkeyHash.equals(targetPubkeyHash)) {
        matchedChild = child;
        matchedPath = path;
        DEBUG && console.log(`[TX] Found matching key at path: ${path}`);
        break;
      }
      // Zero non-matching child private key
      if (child.privateKey) { crypto.randomFillSync(child.privateKey); child.privateKey.fill(0); }
    }
    if (matchedChild) break;
  }

  if (!matchedChild || !matchedChild.privateKey) {
    throw new Error('Could not find private key for bc1 address in wallet');
  }

  DEBUG && console.log(`[TX] Using derivation path: ${matchedPath}`);

  // Get scripthash for UTXO lookup
  const scripthash = getSegwitScripthash(targetPubkeyHash);
  DEBUG && console.log(`[TX] Scripthash: ${scripthash}`);

  // Fetch UTXOs using scripthash
  const utxos: UTXO[] = await getUtxosByScripthash(scripthash);
  DEBUG && console.log(`[TX] Found ${utxos.length} UTXOs`);

  if (utxos.length === 0) {
    throw new Error(`No UTXOs available for bc1 address ${expectedAddress}`);
  }

  // Validate UTXO fields, txids, and deduplicate
  const txidRegex2 = /^[0-9a-fA-F]{64}$/;
  const seenUtxos2 = new Set<string>();
  const MAX_UTXO_VALUE2 = 21_000_000 * 100_000_000;
  for (let i = utxos.length - 1; i >= 0; i--) {
    const u = utxos[i];
    if (!txidRegex2.test(u.txid)) { utxos.splice(i, 1); continue; }
    if (!Number.isInteger(u.value) || u.value <= 0 || u.value > MAX_UTXO_VALUE2) { utxos.splice(i, 1); continue; }
    if (!Number.isInteger(u.vout) || u.vout < 0 || u.vout > 0xFFFFFFFF) { utxos.splice(i, 1); continue; }
    const key = `${u.txid}:${u.vout}`;
    if (seenUtxos2.has(key)) { utxos.splice(i, 1); continue; }
    seenUtxos2.add(key);
  }

  if (utxos.length === 0) {
    throw new Error(`All UTXOs for bc1 address ${expectedAddress} were invalid after validation`);
  }

  // Sort UTXOs by value (largest first)
  utxos.sort((a, b) => b.value - a.value);

  // Estimate transaction size
  const estimateTxSize = (inputCount: number, outputCount: number): number => {
    return 10 + (148 * inputCount) + (34 * outputCount);
  };

  // Coin selection
  let selectedUtxos: UTXO[] = [];
  let totalInput = 0;
  const outputCount = 2;

  for (const utxo of utxos) {
    selectedUtxos.push(utxo);
    totalInput += utxo.value;
    if (totalInput > Number.MAX_SAFE_INTEGER) throw new Error('UTXO total exceeds safe integer range');

    const estimatedSize = estimateTxSize(selectedUtxos.length, outputCount);
    const estimatedFee = estimatedSize * feePerByte;

    if (totalInput >= amountSats + estimatedFee || selectedUtxos.length >= 500) {
      break;
    }
  }

  // Calculate fee with 2 outputs first to determine if change is viable
  const fee2out = estimateTxSize(selectedUtxos.length, 2) * feePerByte;
  const tentativeChange = totalInput - amountSats - fee2out;

  // If change would be dust (<=546), recalculate fee with 1 output
  const hasChange = tentativeChange > 546;
  const actualOutputCount = hasChange ? 2 : 1;
  const fee = estimateTxSize(selectedUtxos.length, actualOutputCount) * feePerByte;
  const changeAmount = hasChange ? (totalInput - amountSats - fee) : 0;

  if (totalInput < amountSats + fee) {
    if (selectedUtxos.length >= 500) {
      throw new Error('Too many UTXOs required. Please consolidate UTXOs first.');
    }
    throw new Error(`Insufficient funds. Need ${amountSats + fee} sats, have ${totalInput} sats`);
  }

  // Build transaction
  DEBUG && console.log(`[TX] Building SegWit recovery transaction:`);
  DEBUG && console.log(`[TX]   To: ${toAddress}`);
  DEBUG && console.log(`[TX]   Amount: ${amountSats} sats`);
  DEBUG && console.log(`[TX]   Fee: ${fee} sats (${feePerByte} sat/byte)`);
  DEBUG && console.log(`[TX]   Change: ${changeAmount} sats`);
  DEBUG && console.log(`[TX]   Inputs: ${selectedUtxos.length}`);

  // For VOID SegWit recovery, we use the same BIP143 sighash and scriptSig format
  // as P2PKH. The node's SegWit recovery code detects the P2WPKH scriptPubKey
  // and validates using the scriptSig contents.
  // NOTE: Change goes to P2PKH (CashAddr) derived from the same pubkey, not back
  // to the bc1 address. The changeAddress param is only used as a flag (non-null = has change).
  let txHex: string;
  privkeyCopy = Buffer.from(matchedChild.privateKey);
  txHex = buildSegwitRecoveryTransaction(
    selectedUtxos,
    toAddress,
    amountSats,
    hasChange ? expectedAddress : null,
    changeAmount,
    privkeyCopy,
    Buffer.from(matchedChild.publicKey),
    targetPubkeyHash
  );

  DEBUG && console.log(`[TX] Transaction hex (${txHex.length} chars): ${txHex}`);

  // Broadcast to VOID network
  DEBUG && console.log(`[TX] Broadcasting to VOID network...`);
  const txid = await broadcastTransaction(txHex);

  return { txid, hex: txHex };

  } finally {
    // Zero seed and all private key material
    if (seed instanceof Buffer || seed instanceof Uint8Array) {
      crypto.randomFillSync(seed);
      seed.fill(0);
    }
    if (root.privateKey) {
      crypto.randomFillSync(root.privateKey);
      root.privateKey.fill(0);
    }
    if (matchedChild && matchedChild.privateKey) {
      crypto.randomFillSync(matchedChild.privateKey);
      matchedChild.privateKey.fill(0);
    }
    if (privkeyCopy) {
      crypto.randomFillSync(privkeyCopy);
      privkeyCopy.fill(0);
    }
  }
}

/**
 * Send transaction from a P2SH-P2WPKH (3xxx wrapped SegWit) address
 * VOID supports spending P2SH-P2WPKH via scriptSig with redeemScript appended
 */
export async function sendFromP2SH(
  mnemonic: string,
  expectedAddress: string,
  toAddress: string,
  amountSats: number,
  feePerByte: number
): Promise<TransactionResult> {
  feePerByte = Math.ceil(feePerByte); // Ensure integer sat/byte
  if (!Number.isFinite(feePerByte) || feePerByte < 1) feePerByte = 1;
  if (feePerByte > 1000) throw new Error('Fee rate too high (max 1000 sat/byte)');
  if (!Number.isInteger(amountSats) || amountSats < 0) throw new Error('Invalid amount');
  if (amountSats < 546) throw new Error('Amount below dust threshold (546 sats)');
  // Derive from mnemonic and search BIP49 paths
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const root = bip32.fromSeed(seed);
  let privkeyCopy: Buffer | null = null;
  let matchedChild: ReturnType<typeof root.derivePath> | null = null;

  try {

  // BIP49 paths: m/49'/0'/0'/0/x (receive) and m/49'/0'/0'/1/x (change)
  const basePaths = ["m/49'/0'/0'/0", "m/49'/0'/0'/1"];

  // To match a 3xxx address we need to compute P2SH(P2WPKH(pubkey)) for each key
  for (const basePath of basePaths) {
    for (let i = 0; i < 100; i++) {
      const path = `${basePath}/${i}`;
      const child = root.derivePath(path);
      const pubkeyHash = hash160(Buffer.from(child.publicKey));

      // redeemScript = OP_0 PUSH_20 <pubkeyhash>
      const rs = Buffer.concat([Buffer.from([0x00, 0x14]), pubkeyHash]);
      const scriptHash = hash160(rs);

      // P2SH address = Base58Check(0x05 || HASH160(redeemScript))
      const versionedHash = Buffer.concat([Buffer.from([0x05]), scriptHash]);
      const p2shAddress = bs58check.encode(versionedHash);

      if (p2shAddress === expectedAddress) {
        matchedChild = child;
        break;
      }
      // Zero non-matching child private key
      if (child.privateKey) { crypto.randomFillSync(child.privateKey); child.privateKey.fill(0); }
    }
    if (matchedChild) break;
  }

  if (!matchedChild || !matchedChild.privateKey) {
    throw new Error('Could not find private key for P2SH address in wallet');
  }

  const pubkeyHash = hash160(Buffer.from(matchedChild.publicKey));
  const redeemScript = Buffer.concat([Buffer.from([0x00, 0x14]), pubkeyHash]);

  // Get scripthash for UTXO lookup (P2SH scriptPubKey)
  const scriptHash = hash160(redeemScript);
  const scriptPubKey = Buffer.concat([
    Buffer.from([0xa9, 0x14]),
    scriptHash,
    Buffer.from([0x87]),
  ]);
  const sha = crypto.createHash('sha256').update(scriptPubKey).digest();
  const scripthash = Buffer.from(sha).reverse().toString('hex');

  // Fetch UTXOs using scripthash
  const utxos: UTXO[] = await getUtxosByScripthash(scripthash);

  if (utxos.length === 0) {
    throw new Error(`No UTXOs available for P2SH address ${expectedAddress}`);
  }

  // Validate UTXO fields, txids, and deduplicate
  const txidRegex3 = /^[0-9a-fA-F]{64}$/;
  const seenUtxos3 = new Set<string>();
  const MAX_UTXO_VALUE3 = 21_000_000 * 100_000_000;
  for (let i = utxos.length - 1; i >= 0; i--) {
    const u = utxos[i];
    if (!txidRegex3.test(u.txid)) { utxos.splice(i, 1); continue; }
    if (!Number.isInteger(u.value) || u.value <= 0 || u.value > MAX_UTXO_VALUE3) { utxos.splice(i, 1); continue; }
    if (!Number.isInteger(u.vout) || u.vout < 0 || u.vout > 0xFFFFFFFF) { utxos.splice(i, 1); continue; }
    const key = `${u.txid}:${u.vout}`;
    if (seenUtxos3.has(key)) { utxos.splice(i, 1); continue; }
    seenUtxos3.add(key);
  }

  if (utxos.length === 0) {
    throw new Error(`All UTXOs for P2SH address ${expectedAddress} were invalid after validation`);
  }

  utxos.sort((a, b) => b.value - a.value);

  const estimateTxSize = (inputCount: number, outputCount: number): number => {
    // P2SH-P2WPKH inputs are ~171 bytes (sig + pubkey + redeemScript push in scriptSig)
    return 10 + (171 * inputCount) + (34 * outputCount);
  };

  let selectedUtxos: UTXO[] = [];
  let totalInput = 0;
  const outputCount = 2;

  for (const utxo of utxos) {
    selectedUtxos.push(utxo);
    totalInput += utxo.value;
    if (totalInput > Number.MAX_SAFE_INTEGER) throw new Error('UTXO total exceeds safe integer range');

    const estimatedSize = estimateTxSize(selectedUtxos.length, outputCount);
    const estimatedFee = estimatedSize * feePerByte;

    if (totalInput >= amountSats + estimatedFee || selectedUtxos.length >= 500) {
      break;
    }
  }

  // Calculate fee with 2 outputs first to determine if change is viable
  const fee2out = estimateTxSize(selectedUtxos.length, 2) * feePerByte;
  const tentativeChange = totalInput - amountSats - fee2out;

  // If change would be dust (<=546), recalculate fee with 1 output
  const hasChange = tentativeChange > 546;
  const actualOutputCount = hasChange ? 2 : 1;
  const fee = estimateTxSize(selectedUtxos.length, actualOutputCount) * feePerByte;
  const changeAmount = hasChange ? (totalInput - amountSats - fee) : 0;

  if (totalInput < amountSats + fee) {
    if (selectedUtxos.length >= 500) {
      throw new Error('Too many UTXOs required. Please consolidate UTXOs first.');
    }
    throw new Error(`Insufficient funds. Need ${amountSats + fee} sats, have ${totalInput} sats`);
  }

  let txHex: string;
  privkeyCopy = Buffer.from(matchedChild.privateKey);
  txHex = buildSegwitRecoveryTransaction(
    selectedUtxos,
    toAddress,
    amountSats,
    hasChange ? expectedAddress : null,
    changeAmount,
    privkeyCopy,
    Buffer.from(matchedChild.publicKey),
    pubkeyHash,
    redeemScript  // Pass redeemScript for P2SH-P2WPKH
  );

  const txid = await broadcastTransaction(txHex);
  return { txid, hex: txHex };

  } finally {
    // Zero seed and all private key material
    if (seed instanceof Buffer || seed instanceof Uint8Array) {
      crypto.randomFillSync(seed);
      seed.fill(0);
    }
    if (root.privateKey) {
      crypto.randomFillSync(root.privateKey);
      root.privateKey.fill(0);
    }
    if (matchedChild && matchedChild.privateKey) {
      crypto.randomFillSync(matchedChild.privateKey);
      matchedChild.privateKey.fill(0);
    }
    if (privkeyCopy) {
      crypto.randomFillSync(privkeyCopy);
      privkeyCopy.fill(0);
    }
  }
}

/**
 * Build a raw transaction spending P2WPKH or P2SH-P2WPKH outputs via SegWit recovery
 * Uses BIP143 sighash with FORKID
 * For bare P2WPKH (bc1): scriptSig = <sig> <pubkey>
 * For P2SH-P2WPKH (3xxx): scriptSig = <sig> <pubkey> <redeemScript>
 */
function buildSegwitRecoveryTransaction(
  utxos: UTXO[],
  toAddress: string,
  amount: number,
  changeAddress: string | null,
  changeAmount: number,
  privateKey: Buffer,
  publicKey: Buffer,
  pubkeyHash: Buffer,
  redeemScript?: Buffer  // For P2SH-P2WPKH: 0x0014<pubkeyhash>
): string {
  if (amount < 0 || changeAmount < 0) throw new Error('Negative amount in transaction');
  if (amount > Number.MAX_SAFE_INTEGER || changeAmount > Number.MAX_SAFE_INTEGER) throw new Error('Amount exceeds safe integer range');
  if (utxos.length === 0) throw new Error('No inputs for transaction');
  if (utxos.length > 500) throw new Error('Too many inputs (max 500) — consolidate UTXOs first');
  // Transaction version
  const version = Buffer.alloc(4);
  version.writeUInt32LE(2, 0);

  // Build outputs
  let outputs = Buffer.alloc(0);
  let outputCount = 1;

  // Output 1: recipient (always VOID CashAddr for sending VOID)
  const recipientScript = addressToScript(toAddress, false);
  const amountBytes = Buffer.alloc(8);
  amountBytes.writeBigUInt64LE(BigInt(amount), 0);
  outputs = Buffer.concat([outputs, amountBytes, encodeVarInt(recipientScript.length), recipientScript]);

  // Output 2: change (back to original address)
  if (changeAddress && changeAmount > 0) {
    outputCount++;
    let changeScript: Buffer;
    // VOID: Always send change to P2PKH (CashAddr) — not back to SegWit/P2SH
    // which would require another recovery spend. P2PKH is natively spendable.
    // OP_DUP OP_HASH160 <pubkeyhash> OP_EQUALVERIFY OP_CHECKSIG
    changeScript = Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]),
      pubkeyHash,
      Buffer.from([0x88, 0xac]),
    ]);
    const changeBytes = Buffer.alloc(8);
    changeBytes.writeBigUInt64LE(BigInt(changeAmount), 0);
    outputs = Buffer.concat([outputs, changeBytes, encodeVarInt(changeScript.length), changeScript]);
  }

  // Precompute BIP143 common hashes (same for all inputs)
  let prevoutsData = Buffer.alloc(0);
  let sequencesData = Buffer.alloc(0);
  for (const u of utxos) {
    const txid = Buffer.from(u.txid, 'hex').reverse();
    const vout = Buffer.alloc(4);
    vout.writeUInt32LE(u.vout, 0);
    prevoutsData = Buffer.concat([prevoutsData, txid, vout]);
    sequencesData = Buffer.concat([sequencesData, Buffer.from('ffffffff', 'hex')]);
  }
  const preHashPrevouts = doubleSha256(prevoutsData);
  const preHashSequence = doubleSha256(sequencesData);
  const preHashOutputs = doubleSha256(outputs);

  // Sign each input using BIP143 sighash
  const signedInputs: Buffer[] = [];
  for (let i = 0; i < utxos.length; i++) {
    const utxo = utxos[i];

    // Create BIP143 sighash for P2WPKH spending
    // scriptCode is the P2PKH script corresponding to the pubkey hash
    const sighash = createBIP143SighashForSegwit(utxos, i, pubkeyHash, outputCount, outputs, utxo.value, preHashPrevouts, preHashSequence, preHashOutputs);

    // Sign
    const signature = signWithPrivateKey(sighash, privateKey);

    // Build scriptSig
    const sigWithHashType = Buffer.concat([signature, Buffer.from([0x41])]); // SIGHASH_ALL | FORKID
    const sigPubkey = Buffer.concat([
      encodeVarInt(sigWithHashType.length),
      sigWithHashType,
      encodeVarInt(publicKey.length),
      publicKey
    ]);
    // For P2SH-P2WPKH: append redeemScript so P2SH evaluation finds it
    // For bare P2WPKH: just <sig> <pubkey>
    const scriptSig = redeemScript
      ? Buffer.concat([sigPubkey, encodeVarInt(redeemScript.length), redeemScript])
      : sigPubkey;

    // Build signed input
    const txidBytes = Buffer.from(utxo.txid, 'hex').reverse();
    const voutBytes = Buffer.alloc(4);
    voutBytes.writeUInt32LE(utxo.vout, 0);
    const sequence = Buffer.from('ffffffff', 'hex');

    signedInputs.push(Buffer.concat([
      txidBytes,
      voutBytes,
      encodeVarInt(scriptSig.length),
      scriptSig,
      sequence
    ]));
  }

  // Assemble full transaction
  let tx = Buffer.concat([version, encodeVarInt(utxos.length)]);
  for (const input of signedInputs) {
    tx = Buffer.concat([tx, input]);
  }
  tx = Buffer.concat([tx, encodeVarInt(outputCount), outputs]);

  // Locktime
  const locktime = Buffer.alloc(4);
  locktime.writeUInt32LE(0, 0);
  tx = Buffer.concat([tx, locktime]);

  return tx.toString('hex');
}

/**
 * Create BIP143 sighash for SegWit spending (P2WPKH)
 * Precomputed hashes passed in to avoid redundant per-input computation.
 */
function createBIP143SighashForSegwit(
  utxos: UTXO[],
  inputIndex: number,
  pubkeyHash: Buffer,
  outputCount: number,
  serializedOutputs: Buffer,
  inputValue: number,
  hashPrevouts: Buffer,
  hashSequence: Buffer,
  hashOutputs: Buffer
): Buffer {
  const utxo = utxos[inputIndex];

  const version = Buffer.alloc(4);
  version.writeUInt32LE(2, 0);

  const outpoint = Buffer.concat([
    Buffer.from(utxo.txid, 'hex').reverse(),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(utxo.vout, 0); return b; })()
  ]);

  const script = Buffer.concat([
    Buffer.from([0x76, 0xa9, 0x14]),
    pubkeyHash,
    Buffer.from([0x88, 0xac])
  ]);
  const scriptCode = Buffer.concat([encodeVarInt(script.length), script]);

  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(BigInt(inputValue), 0);

  const nSequence = Buffer.from('ffffffff', 'hex');

  const locktime = Buffer.alloc(4);
  locktime.writeUInt32LE(0, 0);

  const hashType = Buffer.alloc(4);
  hashType.writeUInt32LE(0x41, 0);

  const preimage = Buffer.concat([
    version,
    hashPrevouts,
    hashSequence,
    outpoint,
    scriptCode,
    value,
    nSequence,
    hashOutputs,
    locktime,
    hashType
  ]);

  return doubleSha256(preimage);
}

/**
 * Build and broadcast a P2WSH recovery transaction
 * P2WSH (witness v0, 32-byte script hash) spending via scriptSig on VOID
 *
 * scriptPubKey: OP_0 PUSH_32 <32-byte-SHA256-of-redeemScript>
 * scriptSig: <sig+hashtype> <pubkey> <redeemScript>
 *
 * The node's VerifyWitnessProgramViaScriptSig checks SHA256(redeemScript) == program,
 * then executes the redeemScript. Sighash uses BIP143 with hashtype 0x41 (SIGHASH_ALL|SIGHASH_FORKID).
 * The scriptCode for BIP143 sighash is the redeemScript itself.
 */
export async function sendFromP2WSH(
  mnemonic: string,
  expectedAddress: string,
  toAddress: string,
  amountSats: number,
  feePerByte: number
): Promise<TransactionResult> {
  feePerByte = Math.ceil(feePerByte);
  if (!Number.isFinite(feePerByte) || feePerByte < 1) feePerByte = 1;
  if (feePerByte > 1000) throw new Error('Fee rate too high (max 1000 sat/byte)');
  if (!Number.isInteger(amountSats) || amountSats < 0) throw new Error('Invalid amount');
  if (amountSats < 546) throw new Error('Amount below dust threshold (546 sats)');
  DEBUG && console.log(`[TX] Sending from P2WSH address: ${expectedAddress}`);

  // Decode the bc1 address to get the 32-byte script hash (witness program)
  const decoded = decodeBech32(expectedAddress);
  if (!decoded || decoded.version !== 0 || decoded.program.length !== 32) {
    throw new Error('Invalid bc1 P2WSH address (expected witness v0 with 32-byte program)');
  }
  const targetScriptHash = decoded.program; // SHA256 of the redeemScript

  // Derive from mnemonic and search BIP84 paths for the key
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const root = bip32.fromSeed(seed);
  let privkeyCopy: Buffer | null = null;
  let matchedChild: ReturnType<typeof root.derivePath> | null = null;

  try {

  // Search BIP84 paths for a key whose P2PKH-like redeemScript hashes to the target
  const basePaths = ["m/84'/0'/0'/0", "m/84'/0'/0'/1", "m/44'/0'/0'/0", "m/44'/0'/0'/1", "m/44'/145'/0'/0", "m/44'/145'/0'/1"];
  let matchedRedeemScript: Buffer | null = null;

  for (const basePath of basePaths) {
    for (let i = 0; i < 100; i++) {
      const path = `${basePath}/${i}`;
      const child = root.derivePath(path);
      const pubkey = Buffer.from(child.publicKey);
      const pubkeyHash = hash160(pubkey);

      // Build P2PKH-like redeemScript: OP_DUP OP_HASH160 <pubkeyhash> OP_EQUALVERIFY OP_CHECKSIG
      const redeemScript = Buffer.concat([
        Buffer.from([0x76, 0xa9, 0x14]),
        pubkeyHash,
        Buffer.from([0x88, 0xac])
      ]);

      // SHA256 of redeemScript should equal the witness program
      const scriptHash = crypto.createHash('sha256').update(redeemScript).digest();
      if (scriptHash.equals(targetScriptHash)) {
        matchedChild = child;
        matchedRedeemScript = redeemScript;
        DEBUG && console.log(`[TX] Found matching P2WSH key at path: ${path}`);
        break;
      }
      // Zero non-matching child private key
      if (child.privateKey) { crypto.randomFillSync(child.privateKey); child.privateKey.fill(0); }
    }
    if (matchedChild) break;
  }

  if (!matchedChild || !matchedChild.privateKey || !matchedRedeemScript) {
    throw new Error('Could not find private key for P2WSH address in wallet');
  }

  // Get scripthash for UTXO lookup
  // scriptPubKey for P2WSH: OP_0 PUSH_32 <32-byte-hash>
  const scriptPubKey = Buffer.concat([
    Buffer.from([0x00, 0x20]),
    targetScriptHash
  ]);
  const sha = crypto.createHash('sha256').update(scriptPubKey).digest();
  const scripthash = Buffer.from(sha).reverse().toString('hex');

  DEBUG && console.log(`[TX] Scripthash: ${scripthash}`);

  // Fetch UTXOs using scripthash
  const utxos: UTXO[] = await getUtxosByScripthash(scripthash);
  DEBUG && console.log(`[TX] Found ${utxos.length} UTXOs`);

  if (utxos.length === 0) {
    throw new Error(`No UTXOs available for P2WSH address ${expectedAddress}`);
  }

  // Validate UTXO fields, txids, and deduplicate
  const txidRegex4 = /^[0-9a-fA-F]{64}$/;
  const seenUtxos4 = new Set<string>();
  const MAX_UTXO_VALUE4 = 21_000_000 * 100_000_000;
  for (let i = utxos.length - 1; i >= 0; i--) {
    const u = utxos[i];
    if (!txidRegex4.test(u.txid)) { utxos.splice(i, 1); continue; }
    if (!Number.isInteger(u.value) || u.value <= 0 || u.value > MAX_UTXO_VALUE4) { utxos.splice(i, 1); continue; }
    if (!Number.isInteger(u.vout) || u.vout < 0 || u.vout > 0xFFFFFFFF) { utxos.splice(i, 1); continue; }
    const key = `${u.txid}:${u.vout}`;
    if (seenUtxos4.has(key)) { utxos.splice(i, 1); continue; }
    seenUtxos4.add(key);
  }

  if (utxos.length === 0) {
    throw new Error(`All UTXOs for P2WSH address ${expectedAddress} were invalid after validation`);
  }

  utxos.sort((a, b) => b.value - a.value);

  // P2WSH inputs are larger: sig(~73) + pubkey(33) + redeemScript(25) + overhead
  const estimateTxSize = (inputCount: number, outputCount: number): number => {
    return 10 + (180 * inputCount) + (34 * outputCount);
  };

  let selectedUtxos: UTXO[] = [];
  let totalInput = 0;

  for (const utxo of utxos) {
    selectedUtxos.push(utxo);
    totalInput += utxo.value;
    if (totalInput > Number.MAX_SAFE_INTEGER) throw new Error('UTXO total exceeds safe integer range');
    const estimatedSize = estimateTxSize(selectedUtxos.length, 2);
    const estimatedFee = estimatedSize * feePerByte;
    if (totalInput >= amountSats + estimatedFee || selectedUtxos.length >= 500) break;
  }

  const fee2out = estimateTxSize(selectedUtxos.length, 2) * feePerByte;
  const tentativeChange = totalInput - amountSats - fee2out;
  const hasChange = tentativeChange > 546;
  const actualOutputCount = hasChange ? 2 : 1;
  const fee = estimateTxSize(selectedUtxos.length, actualOutputCount) * feePerByte;
  const changeAmount = hasChange ? (totalInput - amountSats - fee) : 0;

  if (totalInput < amountSats + fee) {
    if (selectedUtxos.length >= 500) {
      throw new Error('Too many UTXOs required. Please consolidate UTXOs first.');
    }
    throw new Error(`Insufficient funds. Need ${amountSats + fee} sats, have ${totalInput} sats`);
  }

  DEBUG && console.log(`[TX] Building P2WSH recovery transaction:`);
  DEBUG && console.log(`[TX]   To: ${toAddress}`);
  DEBUG && console.log(`[TX]   Amount: ${amountSats} sats`);
  DEBUG && console.log(`[TX]   Fee: ${fee} sats (${feePerByte} sat/byte)`);
  DEBUG && console.log(`[TX]   Change: ${changeAmount} sats`);

  const pubkeyHash = hash160(Buffer.from(matchedChild.publicKey));
  let txHex: string;
  privkeyCopy = Buffer.from(matchedChild.privateKey);
  txHex = buildP2WSHRecoveryTransaction(
    selectedUtxos,
    toAddress,
    amountSats,
    hasChange ? expectedAddress : null,
    changeAmount,
    privkeyCopy,
    Buffer.from(matchedChild.publicKey),
    pubkeyHash,
    matchedRedeemScript
  );

  DEBUG && console.log(`[TX] Transaction hex (${txHex.length} chars): ${txHex}`);

  const txid = await broadcastTransaction(txHex);
  return { txid, hex: txHex };

  } finally {
    if (seed instanceof Buffer || seed instanceof Uint8Array) {
      crypto.randomFillSync(seed);
      seed.fill(0);
    }
    if (root.privateKey) {
      crypto.randomFillSync(root.privateKey);
      root.privateKey.fill(0);
    }
    if (matchedChild && matchedChild.privateKey) {
      crypto.randomFillSync(matchedChild.privateKey);
      matchedChild.privateKey.fill(0);
    }
    if (privkeyCopy) {
      crypto.randomFillSync(privkeyCopy);
      privkeyCopy.fill(0);
    }
  }
}

/**
 * Build a raw transaction spending P2WSH outputs via scriptSig (VOID SegWit recovery)
 *
 * scriptSig: <sig+hashtype> <pubkey> <redeemScript>
 * Sighash: BIP143 with the redeemScript as scriptCode and hashtype 0x41
 */
function buildP2WSHRecoveryTransaction(
  utxos: UTXO[],
  toAddress: string,
  amount: number,
  changeAddress: string | null,
  changeAmount: number,
  privateKey: Buffer,
  publicKey: Buffer,
  pubkeyHash: Buffer,
  redeemScript: Buffer
): string {
  if (amount < 0 || changeAmount < 0) throw new Error('Negative amount in transaction');
  if (amount > Number.MAX_SAFE_INTEGER || changeAmount > Number.MAX_SAFE_INTEGER) throw new Error('Amount exceeds safe integer range');
  if (utxos.length === 0) throw new Error('No inputs for transaction');
  if (utxos.length > 500) throw new Error('Too many inputs (max 500) — consolidate UTXOs first');
  const version = Buffer.alloc(4);
  version.writeUInt32LE(2, 0);

  // Build outputs
  let outputs = Buffer.alloc(0);
  let outputCount = 1;

  const recipientScript = addressToScript(toAddress, false);
  const amountBytes = Buffer.alloc(8);
  amountBytes.writeBigUInt64LE(BigInt(amount), 0);
  outputs = Buffer.concat([outputs, amountBytes, encodeVarInt(recipientScript.length), recipientScript]);

  if (changeAddress && changeAmount > 0) {
    outputCount++;
    // Send change to P2PKH (CashAddr), not back to P2WSH
    const changeScript = Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]),
      pubkeyHash,
      Buffer.from([0x88, 0xac]),
    ]);
    const changeBytes = Buffer.alloc(8);
    changeBytes.writeBigUInt64LE(BigInt(changeAmount), 0);
    outputs = Buffer.concat([outputs, changeBytes, encodeVarInt(changeScript.length), changeScript]);
  }

  // Precompute BIP143 common hashes
  let wshPrevoutsData = Buffer.alloc(0);
  let wshSequencesData = Buffer.alloc(0);
  for (const u of utxos) {
    const txid = Buffer.from(u.txid, 'hex').reverse();
    const vout = Buffer.alloc(4);
    vout.writeUInt32LE(u.vout, 0);
    wshPrevoutsData = Buffer.concat([wshPrevoutsData, txid, vout]);
    wshSequencesData = Buffer.concat([wshSequencesData, Buffer.from('ffffffff', 'hex')]);
  }
  const wshHashPrevouts = doubleSha256(wshPrevoutsData);
  const wshHashSequence = doubleSha256(wshSequencesData);
  const wshHashOutputs = doubleSha256(outputs);

  // Sign each input using BIP143 sighash with redeemScript as scriptCode
  const signedInputs: Buffer[] = [];
  for (let i = 0; i < utxos.length; i++) {
    const utxo = utxos[i];

    // BIP143 sighash using redeemScript as scriptCode (NOT P2PKH template)
    const sighash = createBIP143SighashWithScriptCode(utxos, i, redeemScript, outputCount, outputs, utxo.value, wshHashPrevouts, wshHashSequence, wshHashOutputs);

    const signature = signWithPrivateKey(sighash, privateKey);

    // scriptSig: <sig+hashtype> <pubkey> <redeemScript>
    const sigWithHashType = Buffer.concat([signature, Buffer.from([0x41])]);
    const scriptSig = Buffer.concat([
      encodeVarInt(sigWithHashType.length),
      sigWithHashType,
      encodeVarInt(publicKey.length),
      publicKey,
      encodeVarInt(redeemScript.length),
      redeemScript
    ]);

    const txidBytes = Buffer.from(utxo.txid, 'hex').reverse();
    const voutBytes = Buffer.alloc(4);
    voutBytes.writeUInt32LE(utxo.vout, 0);
    const sequence = Buffer.from('ffffffff', 'hex');

    signedInputs.push(Buffer.concat([
      txidBytes,
      voutBytes,
      encodeVarInt(scriptSig.length),
      scriptSig,
      sequence
    ]));
  }

  let tx = Buffer.concat([version, encodeVarInt(utxos.length)]);
  for (const input of signedInputs) {
    tx = Buffer.concat([tx, input]);
  }
  tx = Buffer.concat([tx, encodeVarInt(outputCount), outputs]);

  const locktime = Buffer.alloc(4);
  locktime.writeUInt32LE(0, 0);
  tx = Buffer.concat([tx, locktime]);

  return tx.toString('hex');
}

/**
 * Create BIP143 sighash using an arbitrary scriptCode (for P2WSH spending)
 * Precomputed hashes passed in to avoid redundant per-input computation.
 */
function createBIP143SighashWithScriptCode(
  utxos: UTXO[],
  inputIndex: number,
  scriptCodeRaw: Buffer,
  outputCount: number,
  serializedOutputs: Buffer,
  inputValue: number,
  hashPrevouts: Buffer,
  hashSequence: Buffer,
  hashOutputs: Buffer
): Buffer {
  const utxo = utxos[inputIndex];

  const version = Buffer.alloc(4);
  version.writeUInt32LE(2, 0);

  const outpoint = Buffer.concat([
    Buffer.from(utxo.txid, 'hex').reverse(),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(utxo.vout, 0); return b; })()
  ]);

  // scriptCode: varint-prefixed redeemScript
  const scriptCode = Buffer.concat([encodeVarInt(scriptCodeRaw.length), scriptCodeRaw]);

  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(BigInt(inputValue), 0);

  const nSequence = Buffer.from('ffffffff', 'hex');

  const locktime = Buffer.alloc(4);
  locktime.writeUInt32LE(0, 0);

  const hashType = Buffer.alloc(4);
  hashType.writeUInt32LE(0x41, 0);

  const preimage = Buffer.concat([
    version,
    hashPrevouts,
    hashSequence,
    outpoint,
    scriptCode,
    value,
    nSequence,
    hashOutputs,
    locktime,
    hashType
  ]);

  return doubleSha256(preimage);
}

/**
 * Build and broadcast a P2TR (Taproot) recovery transaction
 * P2TR key-path spending via scriptSig on VOID
 *
 * scriptSig: <64-byte-schnorr-sig> (single push, no pubkey, no hashtype byte for SIGHASH_DEFAULT)
 * Sighash: BIP341 Taproot sighash
 * Signing: BIP340 Schnorr with tweaked private key
 */
export async function sendFromP2TR(
  mnemonic: string,
  expectedAddress: string,
  toAddress: string,
  amountSats: number,
  feePerByte: number
): Promise<TransactionResult> {
  feePerByte = Math.ceil(feePerByte);
  if (!Number.isFinite(feePerByte) || feePerByte < 1) feePerByte = 1;
  if (feePerByte > 1000) throw new Error('Fee rate too high (max 1000 sat/byte)');
  if (!Number.isInteger(amountSats) || amountSats < 0) throw new Error('Invalid amount');
  if (amountSats < 546) throw new Error('Amount below dust threshold (546 sats)');
  DEBUG && console.log(`[TX] Sending from P2TR address: ${expectedAddress}`);

  // Decode the bc1p address (Bech32m, witness version 1, 32-byte program)
  const decoded = decodeBech32m(expectedAddress);
  if (!decoded || decoded.version !== 1 || decoded.program.length !== 32) {
    throw new Error('Invalid bc1p P2TR address (expected witness v1 with 32-byte x-only pubkey)');
  }
  const targetTweakedXonly = decoded.program;

  // Derive from mnemonic and search BIP86 paths
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const root = bip32.fromSeed(seed);
  let matchedChild: ReturnType<typeof root.derivePath> | null = null;
  let matchedTweakedPrivkey: Buffer | null = null;

  try {

  const basePaths = ["m/86'/0'/0'/0", "m/86'/0'/0'/1"];

  for (const basePath of basePaths) {
    for (let i = 0; i < 100; i++) {
      const path = `${basePath}/${i}`;
      const child = root.derivePath(path);
      const pubkey = Buffer.from(child.publicKey);
      const xonly = pubkey.subarray(1, 33);

      // Compute TapTweak
      const tweak = taggedHashBuf('TapTweak', xonly);

      // Use ecc.xOnlyPointAddTweak to get the tweaked x-only pubkey
      const tweakResult = ecc.xOnlyPointAddTweak(xonly, tweak);
      if (!tweakResult) {
        if (child.privateKey) { crypto.randomFillSync(child.privateKey); child.privateKey.fill(0); }
        continue;
      }

      const tweakedXonly = Buffer.from(tweakResult.xOnlyPubkey);

      if (tweakedXonly.equals(targetTweakedXonly)) {
        matchedChild = child;

        // Compute tweaked private key
        const privkey = Buffer.from(child.privateKey!);
        // Determine if pubkey has even or odd y
        const hasEvenY = pubkey[0] === 0x02;
        // If odd y, negate the private key first
        let effectivePrivkey: Buffer;
        if (hasEvenY) {
          effectivePrivkey = privkey;
        } else {
          const negated = ecc.privateNegate(privkey);
          effectivePrivkey = Buffer.from(negated);
          if (negated instanceof Uint8Array) negated.fill(0);
        }
        // tweakedPrivKey = effectivePrivkey + tweak (mod n)
        const added = ecc.privateAdd(effectivePrivkey, tweak);
        if (!added) {
          // Zero intermediate key material before continuing
          crypto.randomFillSync(privkey); privkey.fill(0);
          if (effectivePrivkey !== privkey) { crypto.randomFillSync(effectivePrivkey); effectivePrivkey.fill(0); }
          if (child.privateKey) { crypto.randomFillSync(child.privateKey); child.privateKey.fill(0); }
          matchedChild = null;
          continue;
        }
        matchedTweakedPrivkey = Buffer.from(added);
        if (added instanceof Uint8Array) added.fill(0);

        // Zero intermediate private key copies
        crypto.randomFillSync(privkey); privkey.fill(0);
        if (effectivePrivkey !== privkey) { crypto.randomFillSync(effectivePrivkey); effectivePrivkey.fill(0); }

        DEBUG && console.log(`[TX] Found matching P2TR key at path: ${path}`);
        break;
      }
      // Zero non-matching child private key
      if (child.privateKey) { crypto.randomFillSync(child.privateKey); child.privateKey.fill(0); }
    }
    if (matchedChild) break;
  }

  if (!matchedChild || !matchedChild.privateKey || !matchedTweakedPrivkey) {
    throw new Error('Could not find private key for P2TR address in wallet');
  }

  // Get scripthash for UTXO lookup
  // scriptPubKey for P2TR: OP_1 PUSH_32 <32-byte-x-only-tweaked-pubkey>
  const scriptPubKey = Buffer.concat([
    Buffer.from([0x51, 0x20]), // OP_1 PUSH_32
    targetTweakedXonly
  ]);
  const sha = crypto.createHash('sha256').update(scriptPubKey).digest();
  const scripthash = Buffer.from(sha).reverse().toString('hex');

  DEBUG && console.log(`[TX] Scripthash: ${scripthash}`);

  const utxos: UTXO[] = await getUtxosByScripthash(scripthash);
  DEBUG && console.log(`[TX] Found ${utxos.length} UTXOs`);

  if (utxos.length === 0) {
    throw new Error(`No UTXOs available for P2TR address ${expectedAddress}`);
  }

  // Validate UTXO fields and deduplicate
  const txidRegex5 = /^[0-9a-fA-F]{64}$/;
  const seenUtxos5 = new Set<string>();
  const MAX_UTXO_VALUE5 = 21_000_000 * 100_000_000;
  for (let i = utxos.length - 1; i >= 0; i--) {
    const u = utxos[i];
    if (!txidRegex5.test(u.txid)) { utxos.splice(i, 1); continue; }
    if (!Number.isInteger(u.value) || u.value <= 0 || u.value > MAX_UTXO_VALUE5) { utxos.splice(i, 1); continue; }
    if (!Number.isInteger(u.vout) || u.vout < 0 || u.vout > 0xFFFFFFFF) { utxos.splice(i, 1); continue; }
    const key = `${u.txid}:${u.vout}`;
    if (seenUtxos5.has(key)) { utxos.splice(i, 1); continue; }
    seenUtxos5.add(key);
  }

  if (utxos.length === 0) {
    throw new Error(`All UTXOs for P2TR address ${expectedAddress} were invalid after validation`);
  }

  utxos.sort((a, b) => b.value - a.value);

  // P2TR scriptSig input: 64-byte sig push = ~66 bytes + outpoint(36) + sequence(4) + varint overhead
  const estimateTxSize = (inputCount: number, outputCount: number): number => {
    return 10 + (110 * inputCount) + (34 * outputCount);
  };

  let selectedUtxos: UTXO[] = [];
  let totalInput = 0;

  for (const utxo of utxos) {
    selectedUtxos.push(utxo);
    totalInput += utxo.value;
    if (totalInput > Number.MAX_SAFE_INTEGER) throw new Error('UTXO total exceeds safe integer range');
    const estimatedSize = estimateTxSize(selectedUtxos.length, 2);
    const estimatedFee = estimatedSize * feePerByte;
    if (totalInput >= amountSats + estimatedFee || selectedUtxos.length >= 500) break;
  }

  const fee2out = estimateTxSize(selectedUtxos.length, 2) * feePerByte;
  const tentativeChange = totalInput - amountSats - fee2out;
  const hasChange = tentativeChange > 546;
  const actualOutputCount = hasChange ? 2 : 1;
  const fee = estimateTxSize(selectedUtxos.length, actualOutputCount) * feePerByte;
  const changeAmount = hasChange ? (totalInput - amountSats - fee) : 0;

  if (totalInput < amountSats + fee) {
    if (selectedUtxos.length >= 500) {
      throw new Error('Too many UTXOs required. Please consolidate UTXOs first.');
    }
    throw new Error(`Insufficient funds. Need ${amountSats + fee} sats, have ${totalInput} sats`);
  }

  DEBUG && console.log(`[TX] Building P2TR recovery transaction:`);
  DEBUG && console.log(`[TX]   To: ${toAddress}`);
  DEBUG && console.log(`[TX]   Amount: ${amountSats} sats`);
  DEBUG && console.log(`[TX]   Fee: ${fee} sats (${feePerByte} sat/byte)`);
  DEBUG && console.log(`[TX]   Change: ${changeAmount} sats`);

  // Build all input scriptPubKeys for sighash computation
  const inputScriptPubKeys: Buffer[] = selectedUtxos.map(() => scriptPubKey);

  let txHex: string;
  txHex = buildP2TRRecoveryTransaction(
    selectedUtxos,
    toAddress,
    amountSats,
    hasChange ? expectedAddress : null,
    changeAmount,
    matchedTweakedPrivkey,
    targetTweakedXonly,
    inputScriptPubKeys,
    Buffer.from(matchedChild.publicKey) // Original untweaked pubkey for change address
  );

  DEBUG && console.log(`[TX] Transaction hex (${txHex.length} chars): ${txHex}`);

  const txid = await broadcastTransaction(txHex);
  return { txid, hex: txHex };

  } finally {
    if (seed instanceof Buffer || seed instanceof Uint8Array) {
      crypto.randomFillSync(seed);
      seed.fill(0);
    }
    if (root.privateKey) {
      crypto.randomFillSync(root.privateKey);
      root.privateKey.fill(0);
    }
    if (matchedChild && matchedChild.privateKey) {
      crypto.randomFillSync(matchedChild.privateKey);
      matchedChild.privateKey.fill(0);
    }
    if (matchedTweakedPrivkey) {
      crypto.randomFillSync(matchedTweakedPrivkey);
      matchedTweakedPrivkey.fill(0);
    }
  }
}

/**
 * Build a raw transaction spending P2TR outputs via scriptSig (VOID Taproot recovery)
 *
 * Key-path spend:
 * - scriptSig: <64-byte-schnorr-sig> (single push)
 * - Sighash: BIP341 Taproot sighash with SIGHASH_DEFAULT (0x00)
 */
function buildP2TRRecoveryTransaction(
  utxos: UTXO[],
  toAddress: string,
  amount: number,
  changeAddress: string | null,
  changeAmount: number,
  tweakedPrivkey: Buffer,
  tweakedXonly: Buffer,
  inputScriptPubKeys: Buffer[],
  originalPublicKey?: Buffer
): string {
  if (amount < 0 || changeAmount < 0) throw new Error('Negative amount in transaction');
  if (amount > Number.MAX_SAFE_INTEGER || changeAmount > Number.MAX_SAFE_INTEGER) throw new Error('Amount exceeds safe integer range');
  if (utxos.length === 0) throw new Error('No inputs for transaction');
  if (utxos.length > 500) throw new Error('Too many inputs (max 500) — consolidate UTXOs first');
  const version = Buffer.alloc(4);
  version.writeUInt32LE(2, 0);

  // Build outputs
  let outputs = Buffer.alloc(0);
  let outputCount = 1;

  const recipientScript = addressToScript(toAddress, false);
  const amountBytes = Buffer.alloc(8);
  amountBytes.writeBigUInt64LE(BigInt(amount), 0);
  outputs = Buffer.concat([outputs, amountBytes, encodeVarInt(recipientScript.length), recipientScript]);

  if (changeAddress && changeAmount > 0) {
    outputCount++;
    // Send change to P2PKH (CashAddr) using the ORIGINAL (untweaked) public key.
    // Using tweakedXonly here would create an unspendable output since the wallet
    // only knows the untweaked key for derivation path lookups.
    if (!originalPublicKey) {
      throw new Error('originalPublicKey is required for P2TR change output');
    }
    const changePubkeyHash = hash160(originalPublicKey);
    const changeScript = Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]),
      changePubkeyHash,
      Buffer.from([0x88, 0xac]),
    ]);
    const changeBytes = Buffer.alloc(8);
    changeBytes.writeBigUInt64LE(BigInt(changeAmount), 0);
    outputs = Buffer.concat([outputs, changeBytes, encodeVarInt(changeScript.length), changeScript]);
  }

  // Precompute BIP341 common hashes (same for all inputs in SIGHASH_DEFAULT)
  let trPrevoutsData = Buffer.alloc(0);
  let trAmountsData = Buffer.alloc(0);
  let trScriptPubKeysData = Buffer.alloc(0);
  let trSequencesData = Buffer.alloc(0);
  for (let j = 0; j < utxos.length; j++) {
    const u = utxos[j];
    const txid = Buffer.from(u.txid, 'hex').reverse();
    const vout = Buffer.alloc(4);
    vout.writeUInt32LE(u.vout, 0);
    trPrevoutsData = Buffer.concat([trPrevoutsData, txid, vout]);
    const amt = Buffer.alloc(8);
    amt.writeBigUInt64LE(BigInt(u.value), 0);
    trAmountsData = Buffer.concat([trAmountsData, amt]);
    const spk = inputScriptPubKeys[j];
    trScriptPubKeysData = Buffer.concat([trScriptPubKeysData, encodeVarInt(spk.length), spk]);
    trSequencesData = Buffer.concat([trSequencesData, Buffer.from('ffffffff', 'hex')]);
  }
  const trHashPrevouts = singleSha256(trPrevoutsData);
  const trHashAmounts = singleSha256(trAmountsData);
  const trHashScriptPubKeys = singleSha256(trScriptPubKeysData);
  const trHashSequences = singleSha256(trSequencesData);
  const trHashOutputs = singleSha256(outputs);

  // Sign each input using BIP341 Taproot sighash
  const signedInputs: Buffer[] = [];
  for (let i = 0; i < utxos.length; i++) {
    const sighash = createBIP341Sighash(
      utxos,
      i,
      inputScriptPubKeys,
      outputCount,
      outputs,
      trHashPrevouts,
      trHashAmounts,
      trHashScriptPubKeys,
      trHashSequences,
      trHashOutputs
    );

    // BIP340 Schnorr sign with tweaked private key
    const signature = Buffer.from(ecc.signSchnorr(sighash, tweakedPrivkey));

    // scriptSig: just the 64-byte signature (SIGHASH_DEFAULT = no hashtype byte appended)
    const scriptSig = Buffer.concat([
      encodeVarInt(signature.length),
      signature
    ]);

    const txidBytes = Buffer.from(utxos[i].txid, 'hex').reverse();
    const voutBytes = Buffer.alloc(4);
    voutBytes.writeUInt32LE(utxos[i].vout, 0);
    const sequence = Buffer.from('ffffffff', 'hex');

    signedInputs.push(Buffer.concat([
      txidBytes,
      voutBytes,
      encodeVarInt(scriptSig.length),
      scriptSig,
      sequence
    ]));
  }

  let tx = Buffer.concat([version, encodeVarInt(utxos.length)]);
  for (const input of signedInputs) {
    tx = Buffer.concat([tx, input]);
  }
  tx = Buffer.concat([tx, encodeVarInt(outputCount), outputs]);

  const locktime = Buffer.alloc(4);
  locktime.writeUInt32LE(0, 0);
  tx = Buffer.concat([tx, locktime]);

  return tx.toString('hex');
}

/**
 * Create BIP341 Taproot sighash for key-path spend
 *
 * sighash = TaggedHash("TapSighash",
 *   0x00,           // epoch
 *   0x00,           // hash_type (SIGHASH_DEFAULT)
 *   nVersion (4 LE),
 *   nLockTime (4 LE),
 *   SHA256(all prevouts),
 *   SHA256(all input amounts as uint64LE),
 *   SHA256(all input scriptPubKeys with varint length prefix),
 *   SHA256(all sequences),
 *   SHA256(all outputs),
 *   0x00,           // spend_type (key-path, no annex)
 *   input_index (4 LE)
 * )
 */
function createBIP341Sighash(
  utxos: UTXO[],
  inputIndex: number,
  inputScriptPubKeys: Buffer[],
  outputCount: number,
  serializedOutputs: Buffer,
  hashPrevouts: Buffer,
  hashAmounts: Buffer,
  hashScriptPubKeys: Buffer,
  hashSequences: Buffer,
  hashOutputs: Buffer
): Buffer {
  const version = Buffer.alloc(4);
  version.writeUInt32LE(2, 0);

  const locktime = Buffer.alloc(4);
  locktime.writeUInt32LE(0, 0);

  // input_index
  const inputIdx = Buffer.alloc(4);
  inputIdx.writeUInt32LE(inputIndex, 0);

  // Build the message to hash
  const sigMsg = Buffer.concat([
    Buffer.from([0x00]),      // epoch
    Buffer.from([0x00]),      // hash_type (SIGHASH_DEFAULT)
    version,                  // nVersion
    locktime,                 // nLockTime
    hashPrevouts,
    hashAmounts,
    hashScriptPubKeys,
    hashSequences,
    hashOutputs,
    Buffer.from([0x00]),      // spend_type (key-path, no annex)
    inputIdx                  // input_index
  ]);

  return taggedHashBuf('TapSighash', sigMsg);
}

/**
 * Single SHA256 hash (used by BIP341, unlike BIP143 which uses double SHA256)
 */
function singleSha256(data: Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * Tagged hash: SHA256(SHA256(tag) || SHA256(tag) || data)
 * Used by BIP340/BIP341 (Taproot)
 */
function taggedHashBuf(tag: string, data: Buffer): Buffer {
  const tagHash = crypto.createHash('sha256').update(Buffer.from(tag, 'utf8')).digest();
  const combined = Buffer.concat([tagHash, tagHash, data]);
  return crypto.createHash('sha256').update(combined).digest();
}

/**
 * Decode Bech32m address (BIP350) for P2TR (witness version 1+)
 * Bech32m uses checksum XOR 0x2bc830a3 instead of XOR 1
 */
function decodeBech32m(address: string): { version: number; program: Buffer } | null {
  const addr = address.toLowerCase();

  const sepPos = addr.lastIndexOf('1');
  if (sepPos < 1 || sepPos + 7 > addr.length) return null;

  const hrp = addr.slice(0, sepPos);
  const dataStr = addr.slice(sepPos + 1);

  const data: number[] = [];
  for (const c of dataStr) {
    const idx = BECH32_CHARSET.indexOf(c);
    if (idx === -1) return null;
    data.push(idx);
  }

  // Verify Bech32m checksum (polymod XOR 0x2bc830a3)
  const hrpExpanded = bech32HrpExpand(hrp);
  if (bech32Polymod([...hrpExpanded, ...data]) !== 0x2bc830a3) {
    return null;
  }

  const payload = data.slice(0, -6);
  if (payload.length < 1) return null;

  const version = payload[0];
  if (version < 1 || version > 16) return null; // Bech32m is for witness version 1+

  // Convert 5-bit to 8-bit
  const programData = payload.slice(1);
  let acc = 0;
  let bits = 0;
  const program: number[] = [];

  for (const value of programData) {
    acc = (acc << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      program.push((acc >> bits) & 0xff);
    }
  }

  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;

  if (version === 1 && program.length !== 32) return null;
  if (version !== 1 && (program.length < 2 || program.length > 40)) return null;

  return {
    version,
    program: Buffer.from(program)
  };
}

export default {
  sendTransaction,
  sendFromBech32,
  sendFromP2SH,
  sendFromP2WSH,
  sendFromP2TR,
};
