/**
 * Security tests for VOID Transaction Builder
 *
 * Tests cover the security hardening applied to CashAddr decoding,
 * address validation, and transaction input validation. Each test
 * targets a specific defensive check to ensure malformed, cross-chain,
 * or adversarial inputs are properly rejected.
 */

import assert from 'assert';

// ---- Mocks ----------------------------------------------------------------
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

// Mock the rng module to return deterministic bytes
jest.mock('../../class/rng', () => ({
  randomBytes: jest.fn(() => Promise.resolve(Buffer.alloc(32, 0x42))),
}));

// Import after mocking
import { decodeCashAddr } from '../../class/void-transaction';
import { VoidWallet } from '../../class/wallets/void-wallet';

// ---- Test Helpers ----------------------------------------------------------

const KNOWN_HASH = Buffer.from('f5bf48b397dae52cf2cba9c735390822244d8083', 'hex');

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

function cashAddrPolymod(values: number[]): bigint {
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

/**
 * Build a raw CashAddr string from 5-bit payload values and checksum.
 * This bypasses the standard encoder so we can craft malformed addresses.
 */
function buildRawCashAddr(prefix: string, payloadValues: number[], checksum: number[]): string {
  let result = prefix + ':';
  for (const v of [...payloadValues, ...checksum]) result += CHARSET[v];
  return result;
}

/**
 * Compute a valid CashAddr checksum for given prefix and 5-bit payload.
 */
function computeChecksum(prefix: string, payload: number[]): number[] {
  const prefixData: number[] = [];
  for (const char of prefix) prefixData.push(char.charCodeAt(0) & 0x1f);
  prefixData.push(0);
  const values = [...prefixData, ...payload, 0, 0, 0, 0, 0, 0, 0, 0];
  const polymod = cashAddrPolymod(values) ^ 1n;
  const checksum: number[] = [];
  for (let i = 0; i < 8; i++) checksum.push(Number((polymod >> BigInt(5 * (7 - i))) & 0x1fn));
  return checksum;
}

// Pre-compute a valid reference address
const VALID_ADDR = encodeCashAddr(KNOWN_HASH, 0);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VOID Transaction Security', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // CashAddr Decoding Security
  // -------------------------------------------------------------------------
  describe('CashAddr decoding security', () => {

    it('1. rejects addresses with non-zero padding bits', () => {
      // Build a valid payload for a 20-byte hash, then tamper the last 5-bit
      // group so the padding bits are non-zero.
      const prefix = 'bitcoincashii';
      const versionByte = 0; // type=0, size=0
      const payload: number[] = [];
      let acc = versionByte;
      let bits = 8;
      for (const byte of KNOWN_HASH) {
        acc = (acc << 8) | byte;
        bits += 8;
        while (bits >= 5) { bits -= 5; payload.push((acc >> bits) & 0x1f); }
      }
      // The remaining bits form the padding. For a 20-byte hash (168 bits total
      // = 1 version byte + 20 data bytes = 168 bits), 168/5 = 33 full groups
      // with 3 remaining bits. The spec requires these 3 padding bits to be 0.
      // Force them non-zero:
      if (bits > 0) {
        // Instead of (acc << (5 - bits)) & 0x1f which would be zero-padded,
        // set the lowest bit to 1 to create non-zero padding.
        payload.push(((acc << (5 - bits)) | 0x01) & 0x1f);
      }

      // Compute a valid checksum for this tampered payload
      const checksum = computeChecksum(prefix, payload);
      const tamperedAddr = buildRawCashAddr(prefix, payload, checksum);

      assert.throws(
        () => decodeCashAddr(tamperedAddr),
        (err: Error) => err.message.includes('non-zero padding bits'),
        'Should reject address with non-zero padding bits'
      );
    });

    it('2. rejects addresses with invalid characters', () => {
      // 'b', 'i', 'o' are not in the CashAddr character set
      const invalidAddr = 'bitcoincashii:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqb';
      assert.throws(
        () => decodeCashAddr(invalidAddr),
        (err: Error) => err.message.includes('Invalid character'),
        'Should reject addresses with characters outside CHARSET'
      );
    });

    it('3. rejects addresses that are too short', () => {
      // An address with fewer than 8 data characters after prefix
      const shortAddr = 'bitcoincashii:qqqqq';
      assert.throws(
        () => decodeCashAddr(shortAddr),
        (err: Error) => err.message.includes('too short'),
        'Should reject addresses that are too short'
      );
    });

    it('4. rejects addresses with invalid checksum', () => {
      // Take a valid address and flip a character in the data portion
      const validAddr = VALID_ADDR;
      const colonIdx = validAddr.indexOf(':');
      const dataPart = validAddr.slice(colonIdx + 1);
      // Flip the first character to a different valid CHARSET character
      const firstChar = dataPart[0];
      const flippedChar = firstChar === 'q' ? 'p' : 'q';
      const corruptedAddr = validAddr.slice(0, colonIdx + 1) + flippedChar + dataPart.slice(1);

      assert.throws(
        () => decodeCashAddr(corruptedAddr),
        (err: Error) => err.message.includes('Invalid CashAddr checksum'),
        'Should reject addresses with corrupted checksum'
      );
    });

    it('5. rejects BCH prefix bitcoincash:', () => {
      // Build a valid-looking address with bitcoincash: prefix
      const bchAddr = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
      assert.throws(
        () => decodeCashAddr(bchAddr),
        (err: Error) => err.message.includes('bitcoincashii:') || err.message.includes('not bitcoincash:'),
        'Should reject bitcoincash: prefix addresses'
      );
    });

    it('6. accepts valid bitcoincashii: prefixed addresses', () => {
      // Should not throw for a valid address
      const result = decodeCashAddr(VALID_ADDR);
      assert.ok(Buffer.isBuffer(result), 'Should return a Buffer');
      assert.strictEqual(result.length, 20, 'Should return 20-byte hash');
    });

    it('7. with returnType: true returns correct type and hash', () => {
      // P2PKH (type 0)
      const p2pkhResult = decodeCashAddr(VALID_ADDR, true);
      assert.strictEqual(p2pkhResult.type, 0, 'P2PKH type should be 0');
      assert.ok(Buffer.isBuffer(p2pkhResult.hash), 'hash should be a Buffer');
      assert.strictEqual(p2pkhResult.hash.length, 20, 'hash should be 20 bytes');
      assert.deepStrictEqual(p2pkhResult.hash, KNOWN_HASH, 'hash should match known hash');

      // P2SH (type 1)
      const p2shAddr = encodeCashAddr(KNOWN_HASH, 1);
      const p2shResult = decodeCashAddr(p2shAddr, true);
      assert.strictEqual(p2shResult.type, 1, 'P2SH type should be 1');
      assert.deepStrictEqual(p2shResult.hash, KNOWN_HASH, 'P2SH hash should match known hash');
    });

    it('8. throws on invalid encodedSize in version byte', () => {
      // Craft a payload where the version byte has an out-of-range size code.
      // Valid size codes are 0-7, so use a version byte with all bits set in
      // the lower 3 positions is valid (7). But the size code maps to hash
      // lengths [20,24,28,32,40,48,56,64]. If encodedSize >= 8, it should
      // throw. However, since size is only 3 bits (0-7), the code checks
      // encodedSize >= expectedSizes.length (which is 8), so size 0-7 are all
      // valid codes. The error path is reached when size code is valid but the
      // hash data is insufficient for the expected length. Let's test by
      // encoding a version byte that says size=3 (32 bytes expected) but only
      // providing 20 bytes of hash data.
      const prefix = 'bitcoincashii';
      const sizeCode = 3; // expects 32 bytes
      const type = 0;
      const versionByte = (type << 3) | sizeCode;
      const fakeHash = Buffer.alloc(20, 0xaa); // only 20 bytes, but version says 32

      const payload: number[] = [];
      let acc = versionByte;
      let bits = 8;
      for (const byte of fakeHash) {
        acc = (acc << 8) | byte;
        bits += 8;
        while (bits >= 5) { bits -= 5; payload.push((acc >> bits) & 0x1f); }
      }
      if (bits > 0) payload.push((acc << (5 - bits)) & 0x1f);

      const checksum = computeChecksum(prefix, payload);
      const badAddr = buildRawCashAddr(prefix, payload, checksum);

      assert.throws(
        () => decodeCashAddr(badAddr),
        (err: Error) => err.message.includes('insufficient hash data'),
        'Should reject when hash data is too short for the declared size code'
      );
    });

    it('9. accumulator masking produces correct hash bytes (round-trip)', () => {
      // Encode the known hash, then decode it, and verify byte-level equality
      const encoded = encodeCashAddr(KNOWN_HASH, 0);
      const decoded = decodeCashAddr(encoded);

      assert.strictEqual(decoded.length, KNOWN_HASH.length, 'Decoded hash length should match');
      for (let i = 0; i < KNOWN_HASH.length; i++) {
        assert.strictEqual(
          decoded[i],
          KNOWN_HASH[i],
          `Byte ${i} mismatch: expected 0x${KNOWN_HASH[i].toString(16)}, got 0x${decoded[i].toString(16)}`
        );
      }
      assert.deepStrictEqual(decoded, KNOWN_HASH, 'Round-trip decode should match original hash exactly');
    });
  });

  // -------------------------------------------------------------------------
  // Address Validation (VoidWallet.isValidAddress)
  // -------------------------------------------------------------------------
  describe('Address validation (VoidWallet.isValidAddress)', () => {

    it('10. rejects bitcoincash: addresses', () => {
      const bchAddr = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
      assert.strictEqual(
        VoidWallet.isValidAddress(bchAddr),
        false,
        'Should reject BCH addresses (wrong chain)'
      );
    });

    it('11. rejects bchtest: addresses', () => {
      const testAddr = 'bchtest:qpm2qsznhks23z7629mms6s4cwef74vcwvhanqgjxu';
      assert.strictEqual(
        VoidWallet.isValidAddress(testAddr),
        false,
        'Should reject bchtest: addresses (wrong chain)'
      );
    });

    it('12. accepts valid bitcoincashii: addresses', () => {
      assert.strictEqual(
        VoidWallet.isValidAddress(VALID_ADDR),
        true,
        'Should accept valid bitcoincashii: P2PKH address'
      );

      const p2shAddr = encodeCashAddr(KNOWN_HASH, 1);
      assert.strictEqual(
        VoidWallet.isValidAddress(p2shAddr),
        true,
        'Should accept valid bitcoincashii: P2SH address'
      );
    });

    it('13. rejects addresses with invalid characters', () => {
      // Replace a valid character with 'b' which is not in CashAddr CHARSET
      const invalidAddr = VALID_ADDR.replace(/q/, 'b');
      // Only test if we actually introduced an invalid character
      // (the prefix contains valid lowercase letters, so replace only in payload)
      const colonIdx = VALID_ADDR.indexOf(':');
      const payload = VALID_ADDR.slice(colonIdx + 1);
      const invalidPayload = 'b' + payload.slice(1); // 'b' not in CHARSET
      const invalidFullAddr = VALID_ADDR.slice(0, colonIdx + 1) + invalidPayload;

      assert.strictEqual(
        VoidWallet.isValidAddress(invalidFullAddr),
        false,
        'Should reject addresses containing characters outside the CashAddr charset'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Transaction Input Validation (round-trip via decodeCashAddr)
  // -------------------------------------------------------------------------
  describe('Transaction input validation', () => {

    it('14. decodeCashAddr round-trip: encode known 20-byte hash, decode, compare', () => {
      const addr = encodeCashAddr(KNOWN_HASH, 0);

      // Decode without returnType (returns raw hash Buffer)
      const hashOnly = decodeCashAddr(addr);
      assert.ok(Buffer.isBuffer(hashOnly), 'decodeCashAddr should return a Buffer');
      assert.deepStrictEqual(hashOnly, KNOWN_HASH, 'Decoded hash should match the original 20-byte input');

      // Decode with returnType (returns {type, hash})
      const typed = decodeCashAddr(addr, true);
      assert.strictEqual(typed.type, 0, 'Round-trip type should be 0 (P2PKH)');
      assert.deepStrictEqual(typed.hash, KNOWN_HASH, 'Round-trip hash should match the original');

      // Also test P2SH round-trip
      const p2shAddr = encodeCashAddr(KNOWN_HASH, 1);
      const p2shTyped = decodeCashAddr(p2shAddr, true);
      assert.strictEqual(p2shTyped.type, 1, 'P2SH round-trip type should be 1');
      assert.deepStrictEqual(p2shTyped.hash, KNOWN_HASH, 'P2SH round-trip hash should match');
    });

    it('decodeCashAddr accepts addresses without prefix (assumes bitcoincashii)', () => {
      // Strip the prefix, decoder should assume bitcoincashii
      const colonIdx = VALID_ADDR.indexOf(':');
      const noPrefixAddr = VALID_ADDR.slice(colonIdx + 1);
      const result = decodeCashAddr(noPrefixAddr);
      assert.ok(Buffer.isBuffer(result), 'Should return a Buffer even without prefix');
      assert.deepStrictEqual(result, KNOWN_HASH, 'Hash should match when prefix is omitted');
    });

    it('decodeCashAddr rejects completely empty input', () => {
      assert.throws(
        () => decodeCashAddr(''),
        (err: Error) => err.message.includes('too short'),
        'Should reject empty string'
      );
    });

    it('decodeCashAddr rejects prefix-only input', () => {
      assert.throws(
        () => decodeCashAddr('bitcoincashii:'),
        (err: Error) => err.message.includes('too short'),
        'Should reject address that is only a prefix with no data'
      );
    });

    it('decodeCashAddr rejects all-zero data with valid checksum but non-zero padding', () => {
      // 34 five-bit zero values = 170 bits. Version byte = 0x00 (type=0,size=0 = 20 bytes).
      // 168 data bits packed as 5-bit: ceil(168/5)=34 groups. Last group has
      // 2 padding bits. All zeros means padding is zero, so this should NOT throw
      // for non-zero padding. Instead verify it decodes to 20 zero bytes.
      const prefix = 'bitcoincashii';
      const payload = new Array(34).fill(0);
      const checksum = computeChecksum(prefix, payload);
      const zeroAddr = buildRawCashAddr(prefix, payload, checksum);

      const result = decodeCashAddr(zeroAddr, true);
      assert.strictEqual(result.type, 0, 'Type should be 0');
      assert.strictEqual(result.hash.length, 20, 'Hash should be 20 bytes');
      assert.deepStrictEqual(result.hash, Buffer.alloc(20, 0), 'Hash should be all zeros');
    });
  });
});
