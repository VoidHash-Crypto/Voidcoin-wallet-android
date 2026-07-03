/**
 * VOID Airdrop Claim
 *
 * Since VOID forks from VOID at block 53,200, any VOID wallet with balance
 * at that block automatically has the same balance on VOID.
 *
 * This module handles:
 * 1. Importing VOID private keys/seeds
 * 2. Deriving VOID addresses from the same keys (including SegWit bc1 addresses)
 * 3. Checking and displaying VOID balances
 */

import { ECPairAPI, ECPairFactory } from 'ecpair';
import * as bip39 from 'bip39';
import BIP32Factory, { BIP32Interface } from 'bip32';
import ecc from '../blue_modules/noble_ecc';
import * as VoidElectrum from '../blue_modules/VoidElectrum';
import { VoidWallet } from './wallets/void-wallet';

const ECPair: ECPairAPI = ECPairFactory(ecc);
const bip32 = BIP32Factory(ecc);
const crypto = require('crypto');

/**
 * Distinguishes network/Electrum failures from confirmed-zero-balance responses.
 * scanChainWithGapLimit does NOT increment the gap counter for network errors,
 * preventing intermittent Electrum outages from causing missed funds.
 */
export class ElectrumNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElectrumNetworkError';
  }
}

// CashAddr character set
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

// Bech32 character set
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

export interface AirdropClaimResult {
  success: boolean;
  address: string;
  addressType?: 'legacy' | 'bc1' | 'p2sh-segwit' | 'p2tr' | 'p2pk';
  voidAddress: string;
  balance: number;
  voidBalance?: number; // Current VOID balance (for anti-gaming comparison)
  derivationPath?: string;
  error?: string;
}

export interface AirdropScanResult {
  totalBalance: number;
  airdropBalance: number;    // Balance that likely existed at fork (min of VOID, VOID per address)
  postForkBalance: number;   // Excess VOID over VOID (received after fork)
  claims: AirdropClaimResult[];
}

export interface AntiGamingResult {
  warning: string | null;
  blocked: boolean;
}

/**
 * Get anti-gaming status. Warns but never blocks — users who moved
 * their VOID after the fork still have legitimate VOID to claim.
 */
export function getAntiGamingStatus(result: AirdropScanResult): AntiGamingResult {
  if (result.postForkBalance > 0 && result.airdropBalance === 0) {
    return {
      warning: 'No matching VOID balance found at this address. If you moved your VOID after the fork, your VOID is still claimable.',
      blocked: false,
    };
  }
  if (result.postForkBalance > 0) {
    const excess = (result.postForkBalance / 100000000).toFixed(8);
    return {
      warning: `Note: ${excess} VOID exceeds the current VOID balance and may have been received after the fork.`,
      blocked: false,
    };
  }
  return { warning: null, blocked: false };
}

export interface WalletImportResult {
  wallet: VoidWallet;
  voidAddress: string;
  voidAddress: string;
  balance: {
    confirmed: number;
    unconfirmed: number;
  };
}

/**
 * Claim VOID airdrop from VOID WIF private key
 * Checks both legacy (P2PKH) and SegWit (P2WPKH) addresses
 */
export async function claimFromWIF(wif: string): Promise<AirdropClaimResult> {
  let keyPair: ReturnType<ECPairAPI['fromWIF']> | null = null;
  try {
    keyPair = ECPair.fromWIF(wif);
    const pubkeyHash = hash160(Buffer.from(keyPair.publicKey));

    // Get VOID legacy address (for display)
    const voidAddress = getLegacyAddress(pubkeyHash);

    // Get VOID CashAddr
    const voidAddress = encodeCashAddr('bitcoincashii', 0, pubkeyHash);

    // Scan all address types (legacy, P2PK, bc1, P2SH-SegWit, P2TR)
    const claims: AirdropClaimResult[] = [];
    const addressTypes: Array<AirdropClaimResult['addressType']> = ['legacy', 'p2pk', 'bc1', 'p2sh-segwit', 'p2tr'];

    let hadNetworkError = false;
    for (const addrType of addressTypes) {
      try {
        const claim = await scanSingleAddress(pubkeyHash, Buffer.from(keyPair.publicKey), addrType!, undefined);
        if (claim) claims.push(claim);
      } catch (err) {
        if (err instanceof ElectrumNetworkError) hadNetworkError = true;
        // Other errors (e.g. unsupported address type) are silently skipped
      }
    }

    if (claims.length > 0) {
      // Deduplicate claims by address+type to prevent double-counting
      const seenKeys = new Set<string>();
      const dedupedClaims = claims.filter(c => {
        const key = `${c.address}:${c.addressType}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });
      if (dedupedClaims.length === 0) {
        return { success: false, address: voidAddress, addressType: 'legacy', voidAddress: '', balance: 0 };
      }
      const best = dedupedClaims[0];
      return {
        success: true,
        address: best.address,
        addressType: best.addressType,
        voidAddress: best.voidAddress,
        balance: dedupedClaims.reduce((sum, c) => {
          const newSum = sum + c.balance;
          return newSum > Number.MAX_SAFE_INTEGER ? sum : newSum;
        }, 0),
        voidBalance: dedupedClaims.reduce((sum, c) => {
          const newSum = sum + (c.voidBalance ?? 0);
          return newSum > Number.MAX_SAFE_INTEGER ? sum : newSum;
        }, 0),
      };
    }

    return {
      success: false,
      address: voidAddress,
      addressType: 'legacy',
      voidAddress: voidAddress,
      balance: 0,
      error: hadNetworkError
        ? 'Network error — could not reach Electrum server. Please check your connection and try again.'
        : 'No VOID balance found for this key',
    };
  } catch (err: any) {
    return {
      success: false,
      address: '',
      voidAddress: '',
      balance: 0,
      error: err.message || 'Invalid private key',
    };
  } finally {
    // Zero ECPair private key material
    if (keyPair && keyPair.privateKey) {
      crypto.randomFillSync(keyPair.privateKey);
      keyPair.privateKey.fill(0);
    }
  }
}

/**
 * Claim VOID airdrop from BIP39 mnemonic seed phrase
 * Derives addresses using gap-limit scanning across:
 * - BIP44 path: m/44'/145'/0'/0/x (BCH) and m/44'/0'/0'/0/x (BTC legacy)
 * - BIP49 path: m/49'/0'/0'/0/x (Wrapped SegWit P2SH-P2WPKH)
 * - BIP84 path: m/84'/0'/0'/0/x (Native SegWit bc1 addresses)
 * - BIP86 path: m/86'/0'/0'/0/x (Taproot P2TR)
 * - Multiple accounts (0-4) on each path
 * Uses BIP44 gap limit: scans until GAP_LIMIT consecutive empty addresses
 */
export async function claimFromMnemonic(mnemonic: string, passphrase: string = ''): Promise<AirdropClaimResult[]> {
  let root: BIP32Interface | null = null;
  try {
    // Validate mnemonic word count (BIP39: 12, 15, 18, 21, or 24 words)
    const wordCount = mnemonic.trim().split(/\s+/).length;
    if (![12, 15, 18, 21, 24].includes(wordCount)) {
      return [{
        success: false,
        address: '',
        voidAddress: '',
        balance: 0,
        error: `Invalid mnemonic: expected 12, 15, 18, 21, or 24 words, got ${wordCount}`,
      }];
    }
    if (!bip39.validateMnemonic(mnemonic)) {
      return [{
        success: false,
        address: '',
        voidAddress: '',
        balance: 0,
        error: 'Invalid mnemonic phrase',
      }];
    }

    const seed = await bip39.mnemonicToSeed(mnemonic, passphrase);
    root = bip32.fromSeed(seed);
    // Zero seed after BIP32 derivation — root holds master key internally
    if (seed instanceof Buffer || seed instanceof Uint8Array) {
      crypto.randomFillSync(seed);
      seed.fill(0);
    }

    const results: AirdropClaimResult[] = [];
    const seenClaimKeys = new Set<string>();
    const GAP_LIMIT = 20;
    const MAX_INDEX = 200; // Hard cap to prevent infinite scanning
    const MAX_ACCOUNTS = 5; // Scan accounts 0-4
    const BATCH_SIZE = 5;   // Parallel queries per batch
    const MAX_CONSECUTIVE_NET_ERRORS = 10; // Give up chain after this many consecutive network errors

    /**
     * Scan a derivation chain using gap-limit logic.
     * Scans all address types (legacy, p2pk, bc1, p2sh-segwit, p2tr) for each key.
     * Stops after GAP_LIMIT consecutive addresses with no balance across any type.
     */
    async function scanChainWithGapLimit(
      accountNode: BIP32Interface,
      chain: number,
      pathPrefix: string,
      primaryType: 'legacy' | 'bc1' | 'p2sh-segwit' | 'p2tr',
    ): Promise<void> {
      let consecutiveEmpty = 0;
      let consecutiveNetErrors = 0;
      let index = 0;

      while (consecutiveEmpty < GAP_LIMIT && index < MAX_INDEX && consecutiveNetErrors < MAX_CONSECUTIVE_NET_ERRORS) {
        // Batch BATCH_SIZE addresses at a time for performance
        const batchEnd = Math.min(index + BATCH_SIZE, MAX_INDEX);
        const batchPromises: Promise<{ idx: number; claims: AirdropClaimResult[]; networkError: boolean }>[] = [];

        for (let i = index; i < batchEnd; i++) {
          const idx = i;
          batchPromises.push((async () => {
            const chainNode = accountNode.derive(chain);
            const child = chainNode.derive(idx);
            const pubkeyHash = hash160(Buffer.from(child.publicKey));
            const publicKey = Buffer.from(child.publicKey);
            const derivPath = `${pathPrefix}/${chain}/${idx}`;
            const foundClaims: AirdropClaimResult[] = [];
            let hadNetworkError = false;

            try {
              // Check all address types for this key
              const typesToCheck: Array<AirdropClaimResult['addressType']> = [primaryType];
              // Also check legacy (P2PKH) and P2PK for every derived key,
              // since wallets often send between address types within the same HD wallet
              if (primaryType !== 'legacy') typesToCheck.push('legacy');
              typesToCheck.push('p2pk');

              for (const addrType of typesToCheck) {
                try {
                  const claim = await scanSingleAddress(pubkeyHash, publicKey, addrType!, derivPath);
                  if (claim) {
                    const claimKey = `${claim.address}:${claim.addressType}`;
                    if (!seenClaimKeys.has(claimKey)) {
                      seenClaimKeys.add(claimKey);
                      foundClaims.push(claim);
                    }
                  }
                } catch (err) {
                  // Network errors should NOT count toward gap limit
                  if (err instanceof ElectrumNetworkError) {
                    hadNetworkError = true;
                  }
                  // Other errors (e.g. invalid key) are silently skipped
                }
              }
            } finally {
              // Zero derived child private keys
              if (child.privateKey) { crypto.randomFillSync(child.privateKey); child.privateKey.fill(0); }
              if (chainNode.privateKey) { crypto.randomFillSync(chainNode.privateKey); chainNode.privateKey.fill(0); }
            }
            return { idx, claims: foundClaims, networkError: hadNetworkError && foundClaims.length === 0 };
          })());
        }

        const batchResults = await Promise.all(batchPromises);

        for (const { claims: foundClaims, networkError } of batchResults) {
          if (foundClaims.length > 0) {
            results.push(...foundClaims);
            consecutiveEmpty = 0;
            consecutiveNetErrors = 0;
          } else if (networkError) {
            // Network errors don't count toward gap limit (address may have funds)
            // but we cap consecutive network errors to avoid infinite scanning
            consecutiveNetErrors++;
          } else {
            // Confirmed empty address
            consecutiveEmpty++;
            consecutiveNetErrors = 0;
          }
        }

        index = batchEnd;
      }
    }

    // All derivation path configs: [BIP standard, coin types, address type]
    // Include coin type 145 (BCH) for BIP49/84/86 — some BCH wallets used these paths
    const pathConfigs: Array<{
      bip: number;
      coinTypes: number[];
      addressType: 'legacy' | 'bc1' | 'p2sh-segwit' | 'p2tr';
    }> = [
      { bip: 44, coinTypes: [0, 145], addressType: 'legacy' },
      { bip: 49, coinTypes: [0, 145], addressType: 'p2sh-segwit' },
      { bip: 84, coinTypes: [0, 145], addressType: 'bc1' },
      { bip: 86, coinTypes: [0, 145], addressType: 'p2tr' },
    ];

    for (const config of pathConfigs) {
      for (const coinType of config.coinTypes) {
        let emptyAccountStreak = 0;
        for (let account = 0; account < MAX_ACCOUNTS; account++) {
          const accountPath = `m/${config.bip}'/${coinType}'/${account}'`;
          let accountNode: BIP32Interface;
          try {
            accountNode = root.derivePath(accountPath);
          } catch {
            continue;
          }

          // Scan both external (0) and internal/change (1) chains
          for (const chain of [0, 1]) {
            await scanChainWithGapLimit(accountNode, chain, accountPath, config.addressType);
          }

          // Account gap tolerance of 2: skip higher accounts only after
          // 2 consecutive empty accounts (handles non-sequential account usage)
          if (account > 0 && !results.some(r => r.derivationPath?.startsWith(accountPath))) {
            emptyAccountStreak++;
            if (emptyAccountStreak >= 2) break;
          } else {
            emptyAccountStreak = 0;
          }
        }
      }
    }

    // Clean up: disconnect Electrum clients after scan
    try { VoidElectrum.disconnectAll(); } catch {}

    if (results.length === 0) {
      return [{
        success: false,
        address: '',
        voidAddress: '',
        balance: 0,
        error: 'No VOID balance found for this seed',
      }];
    }

    return results;
  } catch (err: any) {
    return [{
      success: false,
      address: '',
      voidAddress: '',
      balance: 0,
      error: err.message || 'Failed to process mnemonic',
    }];
  } finally {
    // Zero BIP32 root private key material
    if (root && root.privateKey) {
      crypto.randomFillSync(root.privateKey);
      root.privateKey.fill(0);
    }
  }
}

/**
 * Import VOID wallet and create VOID wallet with same keys
 */
export async function importVOIDWallet(wif: string): Promise<WalletImportResult> {
  const wallet = new VoidWallet();
  wallet.setSecret(wif);

  const keyPair = ECPair.fromWIF(wif);
  try {
    const pubkeyHash = hash160(Buffer.from(keyPair.publicKey));

    const voidAddress = getLegacyAddress(pubkeyHash);
    const voidAddress = wallet.getAddress();
    if (!voidAddress) throw new Error('Failed to derive VOID address from WIF');

    await wallet.fetchBalance();
    wallet.prepareForSerialization();

    return {
      wallet,
      voidAddress,
      voidAddress,
      balance: {
        confirmed: wallet.balance,
        unconfirmed: wallet.unconfirmed_balance,
      },
    };
  } finally {
    // Zero ECPair private key material
    if (keyPair.privateKey) {
      crypto.randomFillSync(keyPair.privateKey);
      keyPair.privateKey.fill(0);
    }
  }
}

/**
 * Get total claimable VOID from multiple VOID addresses
 */
export async function getTotalClaimable(addresses: string[]): Promise<number> {
  let total = 0;

  for (const address of addresses) {
    try {
      // Convert VOID address to VOID CashAddr format
      const voidAddress = convertToCashAddr(address);
      const balance = await VoidElectrum.getBalanceByAddress(voidAddress);
      if (!Number.isSafeInteger(balance.confirmed) || !Number.isSafeInteger(balance.unconfirmed)) continue;
      total += balance.confirmed + balance.unconfirmed;
      if (total > Number.MAX_SAFE_INTEGER) break;
    } catch (err) {
      // Skip invalid addresses
      continue;
    }
  }

  return total;
}

// Helper functions

function hash160(data: Buffer): Buffer {
  const sha256Hash = crypto.createHash('sha256').update(data).digest();
  const ripemd160Hash = crypto.createHash('ripemd160').update(sha256Hash).digest();
  return ripemd160Hash;
}

function getLegacyAddress(pubkeyHash: Buffer): string {
  // Version byte 0x00 for mainnet P2PKH
  const versionedHash = Buffer.concat([Buffer.from([0x00]), pubkeyHash]);
  const checksum = doubleHash(versionedHash).slice(0, 4);
  const address = Buffer.concat([versionedHash, checksum]);
  return base58Encode(address);
}

function doubleHash(data: Buffer): Buffer {
  const hash1 = crypto.createHash('sha256').update(data).digest();
  const hash2 = crypto.createHash('sha256').update(hash1).digest();
  return hash2;
}

function base58Encode(data: Buffer): string {
  if (data.length === 0) return '';
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt('0x' + data.toString('hex'));
  let result = '';

  while (num > 0n) {
    const remainder = Number(num % 58n);
    num = num / 58n;
    result = ALPHABET[remainder] + result;
  }

  // Add leading zeros
  for (const byte of data) {
    if (byte === 0) {
      result = '1' + result;
    } else {
      break;
    }
  }

  return result;
}

function encodeCashAddr(prefix: string, type: number, hash: Buffer): string {
  if (type !== 0 && type !== 1) throw new Error(`Invalid CashAddr type: ${type}`);
  // Determine size code from hash length
  const sizeMap: Record<number, number> = { 20: 0, 24: 1, 28: 2, 32: 3, 40: 4, 48: 5, 56: 6, 64: 7 };
  if (!(hash.length in sizeMap)) throw new Error(`Invalid hash length for CashAddr: ${hash.length}`);
  const sizeCode = sizeMap[hash.length];

  // Pack version byte (type << 3 | size_code) with hash into 5-bit groups
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

  const checksum = calculateChecksum(prefix, payload);
  const fullPayload = [...payload, ...checksum];

  let result = prefix + ':';
  for (const value of fullPayload) {
    result += CHARSET[value];
  }

  return result;
}

function calculateChecksum(prefix: string, payload: number[]): number[] {
  const prefixData = [];
  for (const char of prefix) {
    prefixData.push(char.charCodeAt(0) & 0x1f);
  }
  prefixData.push(0);

  const values = [...prefixData, ...payload, 0, 0, 0, 0, 0, 0, 0, 0];
  const polymod = cashAddrPolymod(values) ^ 1n;

  const checksum = [];
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

function convertToCashAddr(legacyAddress: string): string {
  if (legacyAddress.length > 100) throw new Error('Address too long');
  // Decode base58 address
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  // Count leading '1' characters (each represents a leading 0x00 byte)
  let leadingZeros = 0;
  for (const char of legacyAddress) {
    if (char === '1') leadingZeros++;
    else break;
  }

  let num = 0n;
  for (const char of legacyAddress) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Invalid address character');
    num = num * 58n + BigInt(idx);
  }

  // Convert to bytes, restoring leading zero bytes
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const decoded = Buffer.from(hex, 'hex');
  const bytes = Buffer.concat([Buffer.alloc(leadingZeros), decoded]);

  // Verify Base58Check checksum (last 4 bytes = first 4 bytes of double-SHA256)
  if (bytes.length < 5) throw new Error('Address too short');
  const payload = bytes.slice(0, bytes.length - 4);
  const checksum = bytes.slice(bytes.length - 4);
  const hash1 = crypto.createHash('sha256').update(payload).digest();
  const hash2 = crypto.createHash('sha256').update(hash1).digest();
  if (!hash2.slice(0, 4).equals(checksum)) {
    throw new Error('Invalid address checksum');
  }

  // Validate payload is exactly 21 bytes (1 version + 20 hash)
  if (payload.length !== 21) throw new Error(`Invalid address payload length: ${payload.length} (expected 21)`);

  // Extract version byte and hash (skip version byte, remove 4-byte checksum)
  const versionByte = bytes[0];
  const hash = bytes.slice(1, 21);

  // Validate version byte: 0x00 = P2PKH mainnet, 0x05 = P2SH mainnet
  // Reject testnet (0x6f, 0xc4) and unknown version bytes
  if (versionByte !== 0x00 && versionByte !== 0x05) {
    throw new Error(`Unsupported address version byte: 0x${versionByte.toString(16)} (expected mainnet P2PKH 0x00 or P2SH 0x05)`);
  }
  const cashAddrType = versionByte === 0x05 ? 1 : 0;

  return encodeCashAddr('bitcoincashii', cashAddrType, hash);
}

// ============================================================================
// Bech32 (SegWit bc1) Support
// ============================================================================

/**
 * Encode a bech32 address (bc1...)
 */
function encodeBech32(hrp: string, version: number, data: Buffer): string {
  const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

  // Convert 8-bit data to 5-bit
  const converted: number[] = [version];
  let acc = 0;
  let bits = 0;

  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      converted.push((acc >> bits) & 0x1f);
    }
  }
  if (bits > 0) {
    converted.push((acc << (5 - bits)) & 0x1f);
  }

  // Calculate checksum
  const checksum = bech32Checksum(hrp, converted);

  // Encode
  let result = hrp + '1';
  for (const value of [...converted, ...checksum]) {
    result += BECH32_CHARSET[value];
  }

  return result;
}

/**
 * Decode a bech32 address to get the witness program
 */
function decodeBech32(address: string): { version: number; program: Buffer } | null {
  const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

  const lower = address.toLowerCase();
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) return null;

  const hrp = lower.slice(0, pos);
  const dataStr = lower.slice(pos + 1);

  const data: number[] = [];
  for (const char of dataStr) {
    const idx = BECH32_CHARSET.indexOf(char);
    if (idx === -1) return null;
    data.push(idx);
  }

  // Verify checksum
  if (!verifyBech32Checksum(hrp, data)) return null;

  // Remove checksum (last 6 chars)
  const payload = data.slice(0, -6);
  if (payload.length < 1) return null;

  const version = payload[0];

  // Convert 5-bit to 8-bit
  const program: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 1; i < payload.length; i++) {
    acc = (acc << 5) | payload[i];
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      program.push((acc >> bits) & 0xff);
    }
  }

  // BIP173: padding bits must be zero
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;

  return { version, program: Buffer.from(program) };
}

/**
 * Bech32 polymod for checksum calculation
 */
function bech32Polymod(values: number[]): number {
  const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;

  for (const value of values) {
    const top = chk >>> 25; // unsigned right shift — chk can be negative after XOR with generators
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) {
        chk ^= GENERATOR[i];
      }
    }
  }

  return chk;
}

/**
 * Expand HRP for checksum calculation
 */
function bech32HrpExpand(hrp: string): number[] {
  const result: number[] = [];
  for (const char of hrp) {
    result.push(char.charCodeAt(0) >> 5);
  }
  result.push(0);
  for (const char of hrp) {
    result.push(char.charCodeAt(0) & 31);
  }
  return result;
}

/**
 * Calculate bech32 checksum
 */
function bech32Checksum(hrp: string, data: number[]): number[] {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const polymod = bech32Polymod(values) ^ 1;

  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((polymod >> (5 * (5 - i))) & 31);
  }
  return checksum;
}

/**
 * Verify bech32 checksum
 */
function verifyBech32Checksum(hrp: string, data: number[]): boolean {
  return bech32Polymod([...bech32HrpExpand(hrp), ...data]) === 1;
}

/**
 * Calculate scripthash for a SegWit P2WPKH address
 * Used for Electrum queries
 */
function getSegwitScripthash(pubkeyHash: Buffer): string {
  // P2WPKH scriptPubKey: OP_0 PUSH_20 <20-byte-pubkeyhash>
  const scriptPubKey = Buffer.concat([
    Buffer.from([0x00, 0x14]),  // OP_0, PUSH_20
    pubkeyHash,
  ]);

  // SHA256 and reverse for Electrum
  const hash = crypto.createHash('sha256').update(scriptPubKey).digest();
  return Buffer.from(hash).reverse().toString('hex');
}

/**
 * Get P2SH-P2WPKH address (3xxx wrapped SegWit)
 * BIP49 format used by many wallets
 */
function getP2SHP2WPKHAddress(pubkeyHash: Buffer): string {
  // redeemScript = OP_0 PUSH_20 <pubkeyhash>
  const redeemScript = Buffer.concat([
    Buffer.from([0x00, 0x14]),
    pubkeyHash,
  ]);

  // P2SH address = Base58Check(0x05 || HASH160(redeemScript))
  const scriptHash = hash160(redeemScript);
  const versionedHash = Buffer.concat([Buffer.from([0x05]), scriptHash]);

  // Base58Check encode
  const checksum = doubleHash(versionedHash).slice(0, 4);
  const addressBytes = Buffer.concat([versionedHash, checksum]);
  return base58Encode(addressBytes);
}

/**
 * Calculate scripthash for P2SH-P2WPKH address
 */
function getP2SHP2WPKHScripthash(pubkeyHash: Buffer): string {
  // redeemScript = OP_0 PUSH_20 <pubkeyhash>
  const redeemScript = Buffer.concat([
    Buffer.from([0x00, 0x14]),
    pubkeyHash,
  ]);

  // P2SH scriptPubKey = OP_HASH160 PUSH_20 <HASH160(redeemScript)> OP_EQUAL
  const scriptHash = hash160(redeemScript);
  const scriptPubKey = Buffer.concat([
    Buffer.from([0xa9, 0x14]),  // OP_HASH160, PUSH_20
    scriptHash,
    Buffer.from([0x87]),  // OP_EQUAL
  ]);

  // SHA256 and reverse for Electrum
  const hash = crypto.createHash('sha256').update(scriptPubKey).digest();
  return Buffer.from(hash).reverse().toString('hex');
}

/**
 * Convert a bc1 address to scripthash for Electrum queries
 */
export function bc1AddressToScripthash(address: string): string | null {
  const decoded = decodeBech32(address);
  if (!decoded || decoded.version !== 0 || decoded.program.length !== 20) {
    return null;
  }
  return getSegwitScripthash(decoded.program);
}

// ============================================================================
// Bech32m (BIP350) Support for P2TR (Taproot) addresses
// ============================================================================

/**
 * Encode a Bech32m address (bc1p... for P2TR)
 * Bech32m checksum uses XOR 0x2bc830a3 instead of XOR 1
 */
function encodeBech32m(hrp: string, version: number, data: Buffer): string {
  // Convert 8-bit data to 5-bit
  const converted: number[] = [version];
  let acc = 0;
  let bits = 0;

  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      converted.push((acc >> bits) & 0x1f);
    }
  }
  if (bits > 0) {
    converted.push((acc << (5 - bits)) & 0x1f);
  }

  const checksum = bech32mChecksum(hrp, converted);

  let result = hrp + '1';
  for (const value of [...converted, ...checksum]) {
    result += BECH32_CHARSET[value];
  }

  return result;
}

/**
 * Decode a Bech32m address (BIP350)
 */
function decodeBech32m(address: string): { version: number; program: Buffer } | null {
  const lower = address.toLowerCase();
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) return null;

  const hrp = lower.slice(0, pos);
  const dataStr = lower.slice(pos + 1);

  const data: number[] = [];
  for (const char of dataStr) {
    const idx = BECH32_CHARSET.indexOf(char);
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
  if (version < 1 || version > 16) return null;

  // Convert 5-bit to 8-bit
  const program: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 1; i < payload.length; i++) {
    acc = (acc << 5) | payload[i];
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      program.push((acc >> bits) & 0xff);
    }
  }

  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;

  if (version === 1 && program.length !== 32) return null;

  return { version, program: Buffer.from(program) };
}

/**
 * Calculate Bech32m checksum (BIP350)
 * Uses XOR 0x2bc830a3 instead of XOR 1
 */
function bech32mChecksum(hrp: string, data: number[]): number[] {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const polymod = bech32Polymod(values) ^ 0x2bc830a3;

  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((polymod >> (5 * (5 - i))) & 31);
  }
  return checksum;
}

// ============================================================================
// Taproot (P2TR / BIP86) Support
// ============================================================================

/**
 * Tagged hash: SHA256(SHA256(tag) || SHA256(tag) || data)
 * Used by BIP340/BIP341 (Taproot)
 */
function taggedHash(tag: string, data: Buffer): Buffer {
  const tagHash = crypto.createHash('sha256').update(Buffer.from(tag, 'utf8')).digest();
  const combined = Buffer.concat([tagHash, tagHash, data]);
  return crypto.createHash('sha256').update(combined).digest();
}

/**
 * Compute the tweaked x-only public key for BIP86 Taproot key-path
 * 1. Get x-only pubkey (strip prefix byte)
 * 2. Compute TapTweak = taggedHash("TapTweak", xonlyPubkey)
 * 3. tweakedPubkey = point_add(pubkey, tweak * G)
 * 4. Return x-only tweaked pubkey (32 bytes)
 */
function computeTweakedXonly(pubkey: Buffer): Buffer | null {
  if (!pubkey || pubkey.length !== 33) return null;
  const xonly = pubkey.subarray(1, 33);
  const tweak = taggedHash('TapTweak', xonly);

  const result = ecc.xOnlyPointAddTweak(xonly, tweak);
  if (!result) return null;

  // BIP341: the tweaked point must have even Y parity.
  // xOnlyPointAddTweak already returns the x-only coordinate (which is
  // parity-agnostic), and result.parity indicates if Y is odd. The x-only
  // pubkey is the same regardless of parity, so no negation needed here —
  // the parity only matters when signing (handled in void-transaction.ts).
  return Buffer.from(result.xOnlyPubkey);
}

/**
 * Get scripthash for a P2PK output (for Electrum queries)
 * scriptPubKey for P2PK: PUSH_33 <33-byte-compressed-pubkey> OP_CHECKSIG
 * Used by coinbase/mining reward outputs
 */
function getP2PKScripthash(publicKey: Buffer): string {
  const scriptPubKey = Buffer.concat([
    Buffer.from([0x21]),  // PUSH_33 (compressed pubkey)
    publicKey,
    Buffer.from([0xac]),  // OP_CHECKSIG
  ]);
  const hash = crypto.createHash('sha256').update(scriptPubKey).digest();
  return Buffer.from(hash).reverse().toString('hex');
}

/**
 * Get scripthash for a P2TR address (for Electrum queries)
 * scriptPubKey for P2TR: OP_1 PUSH_32 <32-byte-x-only-tweaked-pubkey>
 */
function getP2TRScripthash(tweakedXonly: Buffer): string {
  const scriptPubKey = Buffer.concat([
    Buffer.from([0x51, 0x20]), // OP_1 PUSH_32
    tweakedXonly,
  ]);
  const hash = crypto.createHash('sha256').update(scriptPubKey).digest();
  return Buffer.from(hash).reverse().toString('hex');
}

// ============================================================================
// Descriptor / xprv Support (Bitcoin Core wallets)
// ============================================================================

export interface ParsedDescriptor {
  type: 'pkh' | 'wpkh' | 'sh-wpkh' | 'tr';
  extendedKey: string;       // xprv/xpub base58 string
  isPrivate: boolean;
  originPath?: string;       // "84'/0'/0'" from [fingerprint/path]
  fingerprint?: string;
  childPath: string;         // "0/*" or "1/*"
  addressType: 'legacy' | 'bc1' | 'p2sh-segwit' | 'p2tr' | 'p2pk';
  nextIndex?: number;        // from listdescriptors JSON — scan at least this many addresses
}

const DESCRIPTOR_TYPE_MAP: Record<string, { type: ParsedDescriptor['type']; addressType: ParsedDescriptor['addressType'] }> = {
  'pkh': { type: 'pkh', addressType: 'legacy' },
  'wpkh': { type: 'wpkh', addressType: 'bc1' },
  'tr': { type: 'tr', addressType: 'p2tr' },
};

/**
 * Parse a single Bitcoin Core descriptor string.
 * Handles: pkh(...), wpkh(...), sh(wpkh(...)), tr(...)
 */
export function parseDescriptor(raw: string): ParsedDescriptor {
  let desc = raw.trim().replace(/#[a-z0-9]+$/i, '').trim();

  let outerType: string;
  let inner: string;

  if (desc.startsWith('sh(wpkh(') && desc.endsWith('))')) {
    outerType = 'sh-wpkh';
    inner = desc.slice('sh(wpkh('.length, -2);
  } else if (desc.startsWith('pkh(') && desc.endsWith(')')) {
    outerType = 'pkh';
    inner = desc.slice('pkh('.length, -1);
  } else if (desc.startsWith('wpkh(') && desc.endsWith(')')) {
    outerType = 'wpkh';
    inner = desc.slice('wpkh('.length, -1);
  } else if (desc.startsWith('tr(') && desc.endsWith(')')) {
    outerType = 'tr';
    inner = desc.slice('tr('.length, -1);
  } else {
    throw new Error(`Unsupported descriptor type: ${desc.slice(0, 30)}...`);
  }

  let fingerprint: string | undefined;
  let originPath: string | undefined;
  if (inner.startsWith('[')) {
    const closeBracket = inner.indexOf(']');
    if (closeBracket === -1) throw new Error('Malformed descriptor origin');
    const origin = inner.slice(1, closeBracket);
    inner = inner.slice(closeBracket + 1);
    const slashIdx = origin.indexOf('/');
    if (slashIdx !== -1) {
      fingerprint = origin.slice(0, slashIdx);
      originPath = origin.slice(slashIdx + 1);
    } else {
      fingerprint = origin;
    }
  }

  const xkeyMatch = inner.match(/(xprv[A-Za-z0-9]+|xpub[A-Za-z0-9]+|tprv[A-Za-z0-9]+|tpub[A-Za-z0-9]+)/);
  if (!xkeyMatch) throw new Error('No extended key found in descriptor');
  const extendedKey = xkeyMatch[1];
  const isPrivate = extendedKey.startsWith('xprv') || extendedKey.startsWith('tprv');

  const afterKey = inner.slice(inner.indexOf(extendedKey) + extendedKey.length);
  let childPath = afterKey.startsWith('/') ? afterKey.slice(1) : afterKey;
  if (!childPath) childPath = '0/*';

  const mapping = outerType === 'sh-wpkh'
    ? { type: 'sh-wpkh' as const, addressType: 'p2sh-segwit' as const }
    : DESCRIPTOR_TYPE_MAP[outerType];
  if (!mapping) throw new Error(`Unknown descriptor type: ${outerType}`);

  return {
    type: mapping.type,
    extendedKey,
    isPrivate,
    originPath,
    fingerprint,
    childPath,
    addressType: mapping.addressType,
  };
}

/**
 * Accept any user input format and return parsed descriptors:
 * - JSON from `listdescriptors true`
 * - Raw xprv/xpub string
 * - Single descriptor string
 * - Multiple descriptor lines
 */
export function parseDescriptorInput(input: string): ParsedDescriptor[] {
  const trimmed = input.trim();
  const results: ParsedDescriptor[] = [];

  // Try JSON (listdescriptors output) — only parse if input starts with JSON delimiter
  const jsonCandidate = trimmed.startsWith('{') || trimmed.startsWith('[')
    ? trimmed
    : null;

  if (jsonCandidate) {
    try {
      const json = JSON.parse(jsonCandidate);
      const descriptors: { desc: string; next_index?: number; next?: number }[] = json.descriptors || (Array.isArray(json) ? json : []);
      for (const d of descriptors) {
        if (d.desc) {
          try {
            const parsed = parseDescriptor(d.desc);
            parsed.nextIndex = d.next_index ?? d.next;
            results.push(parsed);
          } catch {
            // Skip unparseable descriptors in JSON
          }
        }
      }
      if (results.length > 0) return results;
    } catch {
      // Not valid JSON, fall through
    }
  }

  // Try raw xprv/xpub (no descriptor wrapper)
  const xkeyRaw = trimmed.match(/^(xprv[A-Za-z0-9]+|xpub[A-Za-z0-9]+|tprv[A-Za-z0-9]+|tpub[A-Za-z0-9]+)$/);
  if (xkeyRaw) {
    const key = xkeyRaw[1];
    const isPrivate = key.startsWith('xprv') || key.startsWith('tprv');
    for (const wrapper of ['pkh', 'wpkh', 'sh-wpkh', 'tr'] as const) {
      const mapping = wrapper === 'sh-wpkh'
        ? { type: 'sh-wpkh' as const, addressType: 'p2sh-segwit' as const }
        : DESCRIPTOR_TYPE_MAP[wrapper];
      results.push({
        type: mapping.type,
        extendedKey: key,
        isPrivate,
        childPath: '0/*',
        addressType: mapping.addressType,
      });
    }
    // Also scan P2PK (coinbase/mining rewards use raw pubkey outputs)
    results.push({
      type: 'pkh',
      extendedKey: key,
      isPrivate,
      childPath: '0/*',
      addressType: 'p2pk',
    });
    return results;
  }

  // Try single or multi-line descriptor strings
  const lines = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  for (const line of lines) {
    try {
      results.push(parseDescriptor(line));
    } catch {
      // Skip unparseable lines
    }
  }

  if (results.length === 0) {
    const preview = trimmed.length > 0 ? `Input starts with: "${trimmed.slice(0, 40)}..." (${trimmed.length} chars)` : 'Input is empty';
    throw new Error(`Could not parse any descriptors from input. ${preview}`);
  }

  return results;
}

// Standard derivation account paths per address type (for master xprv scanning)
const DESCRIPTOR_ACCOUNT_PATHS: Record<string, string[]> = {
  legacy: ["m/44'/0'/0'", "m/44'/145'/0'"],
  p2pk: ["m/44'/0'/0'", "m/44'/145'/0'"],
  bc1: ["m/84'/0'/0'", "m/84'/145'/0'"],
  'p2sh-segwit': ["m/49'/0'/0'", "m/49'/145'/0'"],
  p2tr: ["m/86'/0'/0'", "m/86'/145'/0'"],
};

const DESCRIPTOR_GAP_LIMIT = 20;
const DESCRIPTOR_MAX_INDEX = 200;
const DESCRIPTOR_BATCH_SIZE = 5;

/**
 * Scan descriptor/xprv input for all claimable VOID balances.
 * Uses gap-limit scanning and cross-type checking.
 */
export async function scanDescriptorForAirdrop(input: string): Promise<AirdropScanResult> {
  const descriptors = parseDescriptorInput(input);
  const claims: AirdropClaimResult[] = [];
  const seenKeys = new Set<string>();

  const DESCRIPTOR_MAX_NET_ERRORS = 10;

  async function scanChainGapLimit(
    parentNode: BIP32Interface,
    chain: number,
    pathPrefix: string,
    primaryType: NonNullable<AirdropClaimResult['addressType']>,
    minScan: number = 0,
  ): Promise<void> {
    let consecutiveEmpty = 0;
    let consecutiveNetErrors = 0;
    let index = 0;

    while ((consecutiveEmpty < DESCRIPTOR_GAP_LIMIT || index < minScan) && index < DESCRIPTOR_MAX_INDEX && consecutiveNetErrors < DESCRIPTOR_MAX_NET_ERRORS) {
      const batchEnd = Math.min(index + DESCRIPTOR_BATCH_SIZE, DESCRIPTOR_MAX_INDEX);
      const batchPromises: Promise<{ found: AirdropClaimResult[]; networkError: boolean }>[] = [];

      for (let i = index; i < batchEnd; i++) {
        const idx = i;
        batchPromises.push((async () => {
          const chainNode = parentNode.derive(chain);
          const child = chainNode.derive(idx);
          const pubkeyHash = hash160(Buffer.from(child.publicKey));
          const derivPath = `${pathPrefix}/${chain}/${idx}`;
          const found: AirdropClaimResult[] = [];
          let hadNetworkError = false;
          try {
            const typesToCheck: Array<NonNullable<AirdropClaimResult['addressType']>> = [primaryType];
            if (primaryType !== 'legacy') typesToCheck.push('legacy');
            typesToCheck.push('p2pk');
            for (const addrType of typesToCheck) {
              try {
                const claim = await scanSingleAddress(pubkeyHash, Buffer.from(child.publicKey), addrType, derivPath);
                if (claim) {
                  const key = `${claim.address}:${claim.addressType}`;
                  if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    found.push(claim);
                  }
                }
              } catch (err) {
                if (err instanceof ElectrumNetworkError) hadNetworkError = true;
              }
            }
          } finally {
            // Zero derived child private keys
            if (child.privateKey) { crypto.randomFillSync(child.privateKey); child.privateKey.fill(0); }
            if (chainNode.privateKey) { crypto.randomFillSync(chainNode.privateKey); chainNode.privateKey.fill(0); }
          }
          return { found, networkError: hadNetworkError && found.length === 0 };
        })());
      }

      const batchResults = await Promise.all(batchPromises);
      for (const { found, networkError } of batchResults) {
        if (found.length > 0) {
          claims.push(...found);
          consecutiveEmpty = 0;
          consecutiveNetErrors = 0;
        } else if (networkError) {
          consecutiveNetErrors++;
        } else {
          consecutiveEmpty++;
          consecutiveNetErrors = 0;
        }
      }
      index = batchEnd;
    }
  }

  for (const desc of descriptors) {
    let node: BIP32Interface;
    try {
      node = bip32.fromBase58(desc.extendedKey);
    } catch {
      continue;
    }

    const minScan = desc.nextIndex ? desc.nextIndex + DESCRIPTOR_GAP_LIMIT : 0;
    try {
      if (node.depth >= 3) {
        const pathPrefix = desc.originPath ? `m/${desc.originPath}` : '';
        for (const chain of [0, 1]) {
          await scanChainGapLimit(node, chain, pathPrefix, desc.addressType, minScan);
        }
      } else {
        const accountPaths = DESCRIPTOR_ACCOUNT_PATHS[desc.addressType] || [];
        const accountNodes: BIP32Interface[] = [];
        for (const accountPath of accountPaths) {
          let accountNode: BIP32Interface;
          try {
            accountNode = node.derivePath(accountPath);
          } catch {
            continue;
          }
          accountNodes.push(accountNode);
          for (const chain of [0, 1]) {
            await scanChainGapLimit(accountNode, chain, accountPath, desc.addressType, minScan);
          }
        }
        // Zero derived account nodes
        for (const an of accountNodes) {
          if (an.privateKey) { crypto.randomFillSync(an.privateKey); an.privateKey.fill(0); }
        }
      }
    } finally {
      // Zero xprv node private key
      if (node.privateKey) { crypto.randomFillSync(node.privateKey); node.privateKey.fill(0); }
    }
  }

  // Clean up: disconnect Electrum clients after scan
  try { VoidElectrum.disconnectAll(); } catch {}

  const totalBalance = claims.reduce((sum, c) => {
    if (!Number.isSafeInteger(c.balance)) return sum;
    return sum + c.balance;
  }, 0);
  const airdropBalance = claims.reduce((sum, c) => {
    const void = c.voidBalance ?? 0;
    if (!Number.isSafeInteger(c.balance) || !Number.isSafeInteger(void)) return sum;
    return sum + Math.min(c.balance, void);
  }, 0);

  return {
    totalBalance,
    airdropBalance,
    postForkBalance: totalBalance - airdropBalance,
    claims,
  };
}

/**
 * Scan a single address for VOID balance.
 * Handles different address types (legacy, bc1, p2sh-segwit, p2tr).
 * Returns null for confirmed-zero balance.
 * Throws ElectrumNetworkError for network failures (callers should not
 * count these toward the gap limit).
 */
async function scanSingleAddress(
  pubkeyHash: Buffer,
  publicKey: Buffer,
  addressType: 'legacy' | 'bc1' | 'p2sh-segwit' | 'p2tr' | 'p2pk',
  derivationPath?: string,
): Promise<AirdropClaimResult | null> {
  let address: string;
  let voidAddress: string;
  let scripthash: string;

  voidAddress = encodeCashAddr('bitcoincashii', 0, pubkeyHash);

  switch (addressType) {
    case 'legacy':
      address = getLegacyAddress(pubkeyHash);
      scripthash = ''; // Will use getBalanceByAddress for legacy
      break;
    case 'p2pk':
      // P2PK: <pubkey> OP_CHECKSIG — used by coinbase/mining rewards
      address = getLegacyAddress(pubkeyHash);
      scripthash = getP2PKScripthash(publicKey);
      break;
    case 'bc1':
      address = encodeBech32('bc', 0, pubkeyHash);
      scripthash = getSegwitScripthash(pubkeyHash);
      break;
    case 'p2sh-segwit':
      address = getP2SHP2WPKHAddress(pubkeyHash);
      scripthash = getP2SHP2WPKHScripthash(pubkeyHash);
      break;
    case 'p2tr': {
      const tweaked = computeTweakedXonly(publicKey);
      if (!tweaked) return null;
      address = encodeBech32m('bc', 1, tweaked);
      scripthash = getP2TRScripthash(tweaked);
      break;
    }
  }

  // Query VOID balance — throw ElectrumNetworkError on failure so callers
  // can distinguish "confirmed zero" from "network error" for gap-limit logic
  let total: number;
  try {
    if (addressType === 'legacy') {
      const balance = await VoidElectrum.getBalanceByAddress(voidAddress);
      if (!Number.isSafeInteger(balance.confirmed) || !Number.isSafeInteger(balance.unconfirmed)) throw new ElectrumNetworkError('Invalid balance response');
      total = balance.confirmed + balance.unconfirmed;
    } else {
      const balance = await VoidElectrum.getBalanceByScripthash(scripthash);
      if (!Number.isSafeInteger(balance.confirmed) || !Number.isSafeInteger(balance.unconfirmed)) throw new ElectrumNetworkError('Invalid balance response');
      total = balance.confirmed + balance.unconfirmed;
    }
  } catch (err: any) {
    throw new ElectrumNetworkError(err.message || 'Electrum query failed');
  }

  if (total <= 0) return null; // Confirmed zero balance

  let voidTotal = 0;
  try {
    if (addressType === 'legacy') {
      const voidResult = await VoidElectrum.getVoidBalance(address);
      voidTotal = voidResult.confirmed + voidResult.unconfirmed;
    } else {
      const voidResult = await VoidElectrum.getVoidBalanceByScripthash(scripthash);
      voidTotal = voidResult.confirmed + voidResult.unconfirmed;
    }
  } catch {
    // VOID check failed — non-critical, continue with voidTotal=0
  }

  return {
    success: true,
    address,
    addressType,
    voidAddress,
    balance: total,
    voidBalance: voidTotal,
    derivationPath,
  };
}

/**
 * Build AirdropScanResult from claimFromWIF or claimFromMnemonic results.
 * Helper for the wizard UI.
 */
export function buildScanResult(results: AirdropClaimResult[]): AirdropScanResult {
  const claims = results.filter(r => r.success && r.balance > 0);
  const totalBalance = claims.reduce((sum, c) => {
    if (!Number.isSafeInteger(c.balance)) return sum;
    return sum + c.balance;
  }, 0);
  const airdropBalance = claims.reduce((sum, c) => {
    const void = c.voidBalance ?? 0;
    if (!Number.isSafeInteger(c.balance) || !Number.isSafeInteger(void)) return sum;
    return sum + Math.min(c.balance, void);
  }, 0);

  return {
    totalBalance,
    airdropBalance,
    postForkBalance: totalBalance - airdropBalance,
    claims,
  };
}

export default {
  claimFromWIF,
  claimFromMnemonic,
  importVOIDWallet,
  getTotalClaimable,
  bc1AddressToScripthash,
  scanDescriptorForAirdrop,
  parseDescriptorInput,
  parseDescriptor,
  getAntiGamingStatus,
  buildScanResult,
};
