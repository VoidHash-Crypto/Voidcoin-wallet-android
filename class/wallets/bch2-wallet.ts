/**
 * VOID Wallet (P2PKH Legacy)
 * VoidCoin wallet using CashAddr format
 */

import { ECPairAPI, ECPairFactory } from 'ecpair';
import ecc from '../../blue_modules/noble_ecc';
import * as VoidElectrum from '../../blue_modules/VoidElectrum';
import { AbstractWallet } from './abstract-wallet';
import { Transaction, Utxo } from './types';
import { randomBytes } from '../rng';

const ECPair: ECPairAPI = ECPairFactory(ecc);
const crypto = require('crypto');

// CashAddr character set
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/**
 * VOID Legacy Wallet (P2PKH with CashAddr)
 */
export class VoidWallet extends AbstractWallet {
  static readonly type = 'voidLegacy';
  static readonly typeReadable = 'VOID (CashAddr)';
  // @ts-ignore: override
  public readonly type = VoidWallet.type;
  // @ts-ignore: override
  public readonly typeReadable = VoidWallet.typeReadable;

  _transactions: Transaction[] = [];

  async generate(): Promise<void> {
    const buf = await randomBytes(32);
    this.secret = ECPair.makeRandom({ rng: () => buf }).toWIF();
  }

  /**
   * Import from WIF private key
   */
  setSecret(newSecret: string): this {
    this.secret = newSecret.trim();
    return this;
  }

  /**
   * Get VOID CashAddr format address
   */
  getAddress(): string | false {
    if (this._address) return this._address;

    try {
      const keyPair = ECPair.fromWIF(this.secret);
      const pubkeyHash = hash160(Buffer.from(keyPair.publicKey));
      this._address = encodeCashAddr('bitcoincashii', 0, pubkeyHash);
      return this._address;
    } catch (err) {
      return false;
    }
  }

  /**
   * Get all addresses (single address wallet)
   */
  getAllExternalAddresses(): string[] {
    const address = this.getAddress();
    return address ? [address] : [];
  }

  /**
   * Fetch balance from VOID Electrum server
   */
  async fetchBalance(): Promise<void> {
    const address = this.getAddress();
    if (!address) return;

    try {
      const balance = await VoidElectrum.getBalanceByAddress(address);
      this.balance = balance.confirmed;
      this.unconfirmed_balance = balance.unconfirmed;
      this._lastBalanceFetch = Date.now();
    } catch (err) {
      console.log('VOID fetchBalance error:', err);
    }
  }

  /**
   * Fetch transactions from VOID Electrum server
   */
  async fetchTransactions(): Promise<void> {
    const address = this.getAddress();
    if (!address) return;

    try {
      const history = await VoidElectrum.getTransactionsByAddress(address);
      const transactions: Transaction[] = [];

      for (const tx of history) {
        const fullTx = await VoidElectrum.getTransaction(tx.tx_hash);
        if (fullTx) {
          const blockHeight = VoidElectrum.getLatestBlock().height || 0;
          transactions.push({
            txid: tx.tx_hash,
            hash: tx.tx_hash,
            version: fullTx.version || 1,
            size: fullTx.size || 0,
            vsize: fullTx.vsize || fullTx.size || 0,
            weight: fullTx.weight || 0,
            locktime: fullTx.locktime || 0,
            value: 0, // Will be calculated
            time: fullTx.blocktime || Math.floor(Date.now() / 1000),
            blocktime: fullTx.blocktime || Math.floor(Date.now() / 1000),
            timestamp: fullTx.blocktime || Math.floor(Date.now() / 1000),
            blockhash: fullTx.blockhash || '',
            confirmations: tx.height > 0 ? blockHeight - tx.height + 1 : 0,
            inputs: fullTx.vin || [],
            outputs: fullTx.vout || [],
          });
        }
      }

      this._transactions = transactions;
      this._lastTxFetch = Date.now();
    } catch (err) {
      console.log('VOID fetchTransactions error:', err);
    }
  }

  getTransactions(): Transaction[] {
    return this._transactions;
  }

  /**
   * Fetch UTXOs for transaction building
   */
  async fetchUtxos(): Promise<Utxo[]> {
    const address = this.getAddress();
    if (!address) return [];

    try {
      const utxos = await VoidElectrum.getUtxosByAddress(address);
      this._utxo = utxos.map(u => ({
        ...u,
        address,
        wif: this.secret,
      }));
      return this._utxo;
    } catch (err) {
      console.log('VOID fetchUtxos error:', err);
      return [];
    }
  }

  getUtxos(): Utxo[] {
    return this._utxo;
  }

  /**
   * Check if address belongs to this wallet
   */
  weOwnAddress(address: string): boolean {
    const ourAddress = this.getAddress();
    if (!ourAddress) return false;

    // Reject BCH addresses (wrong chain) — do not strip 'bitcoincash:' prefix
    const lowerAddr = address.toLowerCase();
    if (lowerAddr.startsWith('bitcoincash:') && !lowerAddr.startsWith('bitcoincashii:')) {
      return false;
    }

    // Normalize: only strip the VOID prefix for comparison
    const normalize = (addr: string) => {
      const lower = addr.toLowerCase();
      return lower.startsWith('bitcoincashii:') ? lower.slice('bitcoincashii:'.length) : lower;
    };

    return normalize(ourAddress) === normalize(address);
  }

  /**
   * Validate VOID address
   */
  static isValidAddress(address: string): boolean {
    try {
      let addr = address.toLowerCase();
      const prefix = 'bitcoincashii';

      // Only accept bitcoincashii: prefix (reject bitcoincash: and bchtest:)
      if (addr.startsWith('bitcoincash:') && !addr.startsWith('bitcoincashii:')) return false;
      if (addr.startsWith('bchtest:')) return false;

      if (addr.startsWith('bitcoincashii:')) {
        addr = addr.slice('bitcoincashii:'.length);
      }

      // Decode payload
      const data: number[] = [];
      for (const char of addr) {
        const idx = CHARSET.indexOf(char);
        if (idx === -1) return false;
        data.push(idx);
      }

      if (data.length < 34 || data.length > 42) return false;

      // Verify polymod checksum
      const prefixData: number[] = [];
      for (const char of prefix) {
        prefixData.push(char.charCodeAt(0) & 0x1f);
      }
      prefixData.push(0);

      return cashAddrPolymod([...prefixData, ...data]) === 1n;
    } catch {
      return false;
    }
  }

  /**
   * Strip sensitive key material (WIF) from UTXOs before serialization
   * to prevent private keys from leaking into logs, state dumps, or error reports.
   */
  prepareForSerialization(): void {
    this._utxo = this._utxo.map(u => {
      const { wif: _wif, ...rest } = u as any;
      return rest;
    });
  }

  isSegwit(): boolean {
    return false; // VOID doesn't support SegWit
  }

  allowRBF(): boolean {
    return false; // VOID doesn't support RBF
  }
}

/**
 * Hash160 (RIPEMD160(SHA256(data)))
 */
function hash160(data: Buffer): Buffer {
  const sha256Hash = crypto.createHash('sha256').update(data).digest();
  const ripemd160Hash = crypto.createHash('ripemd160').update(sha256Hash).digest();
  return ripemd160Hash;
}

/**
 * Encode pubkey hash to CashAddr format
 */
function encodeCashAddr(prefix: string, type: number, hash: Buffer): string {
  if (type !== 0 && type !== 1) throw new Error(`Invalid CashAddr type: ${type}`);
  // Determine size code from hash length
  const sizeMap: Record<number, number> = { 20: 0, 24: 1, 28: 2, 32: 3, 40: 4, 48: 5, 56: 6, 64: 7 };
  if (!(hash.length in sizeMap)) throw new Error(`Invalid hash length for CashAddr: ${hash.length}`);
  const sizeCode = sizeMap[hash.length];

  // Pack version byte (type << 3 | sizeCode) as 8 bits with hash into 5-bit groups
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

  // Add checksum
  const checksum = calculateCashAddrChecksum(prefix, payload);
  const fullPayload = [...payload, ...checksum];

  // Encode to string
  let result = prefix + ':';
  for (const value of fullPayload) {
    result += CHARSET[value];
  }

  return result;
}

/**
 * Calculate CashAddr checksum
 */
function calculateCashAddrChecksum(prefix: string, payload: number[]): number[] {
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

/**
 * CashAddr polymod function
 */
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

export default VoidWallet;
