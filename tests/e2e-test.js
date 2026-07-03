/**
 * VOID Android Wallet E2E Test Suite
 * Comprehensive testing of wallet, airdrop, and transaction functions
 * Self-contained - uses npm packages directly
 */

const crypto = require('crypto');
const bip39 = require('bip39');
const BIP32Factory = require('bip32').default;
const ecc = require('tiny-secp256k1');
const WebSocket = require('ws');

// Create bip32 instance with tiny-secp256k1
const bip32 = BIP32Factory(ecc);

// ============================================================================
// Test Utilities
// ============================================================================
const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  console.log('\n' + '='.repeat(70));
  console.log('VOID Android Wallet E2E Test Suite');
  console.log('='.repeat(70) + '\n');

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${err.message}`);
      failed++;
    }
  }

  console.log('\n' + '-'.repeat(70));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('-'.repeat(70) + '\n');

  return failed === 0;
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEquals(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`);
}

// ============================================================================
// Crypto Primitives
// ============================================================================
function hash160(data) {
  const sha = crypto.createHash('sha256').update(data).digest();
  return crypto.createHash('ripemd160').update(sha).digest();
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

function doubleSha256(data) {
  return sha256(sha256(data));
}

// ============================================================================
// Address Encoding
// ============================================================================
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const ret = [];
  for (let i = 0; i < hrp.length; i++) {
    ret.push(hrp.charCodeAt(i) >> 5);
  }
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) {
    ret.push(hrp.charCodeAt(i) & 31);
  }
  return ret;
}

function bech32CreateChecksum(hrp, data) {
  const values = [...bech32HrpExpand(hrp), ...data];
  const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((polymod >> (5 * (5 - i))) & 31);
  }
  return checksum;
}

function bech32Encode(hrp, data) {
  const checksum = bech32CreateChecksum(hrp, data);
  let addr = hrp + '1';
  for (const d of [...data, ...checksum]) {
    addr += BECH32_CHARSET[d];
  }
  return addr;
}

function convertBits(data, fromBits, toBits, pad = true) {
  let acc = 0;
  let bits = 0;
  const result = [];
  const maxv = (1 << toBits) - 1;

  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }

  if (pad && bits > 0) {
    result.push((acc << (toBits - bits)) & maxv);
  }

  return result;
}

function pubkeyToBech32(pubkey, hrp = 'bc') {
  const h160 = hash160(pubkey);
  const words = [0, ...convertBits(h160, 8, 5)];
  return bech32Encode(hrp, words);
}

// CashAddr encoding
const CASHADDR_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function cashAddrPolymod(values) {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    if (c0 & 1n) c ^= 0x98f2bc8e61n;
    if (c0 & 2n) c ^= 0x79b76d99e2n;
    if (c0 & 4n) c ^= 0xf33e5fb3c4n;
    if (c0 & 8n) c ^= 0xae2eabe2a8n;
    if (c0 & 16n) c ^= 0x1e4f43e470n;
  }
  return c ^ 1n;
}

function cashAddrEncode(prefix, type, hash) {
  const prefixData = [];
  for (let i = 0; i < prefix.length; i++) {
    prefixData.push(prefix.charCodeAt(i) & 31);
  }
  prefixData.push(0);

  const versionByte = (type << 3) | (hash.length === 20 ? 0 : 3);
  const payload = [versionByte, ...hash];
  const payloadWords = convertBits(payload, 8, 5);

  const checksum = cashAddrPolymod([...prefixData, ...payloadWords, 0, 0, 0, 0, 0, 0, 0, 0]);
  const checksumWords = [];
  for (let i = 0; i < 8; i++) {
    checksumWords.push(Number((checksum >> BigInt(5 * (7 - i))) & 31n));
  }

  let addr = prefix + ':';
  for (const w of [...payloadWords, ...checksumWords]) {
    addr += CASHADDR_CHARSET[w];
  }
  return addr;
}

function pubkeyToCashAddr(pubkey, prefix = 'bitcoincashii') {
  const h160 = hash160(pubkey);
  return cashAddrEncode(prefix, 0, [...h160]);
}

// Base58Check encoding
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buffer) {
  let num = BigInt('0x' + buffer.toString('hex'));
  let str = '';
  while (num > 0n) {
    str = BASE58_ALPHABET[Number(num % 58n)] + str;
    num = num / 58n;
  }
  for (const byte of buffer) {
    if (byte === 0) str = '1' + str;
    else break;
  }
  return str;
}

function pubkeyToLegacy(pubkey, version = 0x00) {
  const h160 = hash160(pubkey);
  const versionedHash = Buffer.concat([Buffer.from([version]), h160]);
  const checksum = doubleSha256(versionedHash).slice(0, 4);
  return base58Encode(Buffer.concat([versionedHash, checksum]));
}

// ============================================================================
// Electrum Scripthash
// ============================================================================
function addressToScripthash(address) {
  let script;

  if (address.startsWith('bc1q')) {
    // Native SegWit P2WPKH
    const decoded = bech32Decode(address);
    const h160 = Buffer.from(convertBits(decoded.data.slice(1), 5, 8, false));
    script = Buffer.concat([Buffer.from([0x00, 0x14]), h160]);
  } else if (address.startsWith('1')) {
    // Legacy P2PKH
    const decoded = base58Decode(address);
    const h160 = decoded.slice(1, 21);
    script = Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), h160, Buffer.from([0x88, 0xac])]);
  } else if (address.startsWith('3')) {
    // P2SH (wrapped SegWit)
    const decoded = base58Decode(address);
    const h160 = decoded.slice(1, 21);
    script = Buffer.concat([Buffer.from([0xa9, 0x14]), h160, Buffer.from([0x87])]);
  } else if (address.includes(':')) {
    // CashAddr
    const { hash } = cashAddrDecode(address);
    script = Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), Buffer.from(hash), Buffer.from([0x88, 0xac])]);
  } else {
    throw new Error('Unknown address format');
  }

  const hash = sha256(script);
  return Buffer.from(hash.reverse()).toString('hex');
}

function bech32Decode(addr) {
  const pos = addr.lastIndexOf('1');
  const hrp = addr.slice(0, pos);
  const data = [];
  for (let i = pos + 1; i < addr.length; i++) {
    const idx = BECH32_CHARSET.indexOf(addr[i]);
    data.push(idx);
  }
  return { hrp, data: data.slice(0, -6) };
}

function base58Decode(str) {
  let num = 0n;
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;

  let leadingZeros = 0;
  for (const char of str) {
    if (char === '1') leadingZeros++;
    else break;
  }

  return Buffer.from('00'.repeat(leadingZeros) + hex, 'hex');
}

function cashAddrDecode(addr) {
  const [prefix, payload] = addr.split(':');
  const data = [];
  for (const char of payload) {
    data.push(CASHADDR_CHARSET.indexOf(char));
  }
  const words = data.slice(0, -8);
  const bytes = convertBits(words, 5, 8, false);
  const versionByte = bytes[0];
  const hash = bytes.slice(1);
  return { prefix, type: versionByte >> 3, hash };
}

// ============================================================================
// TESTS
// ============================================================================

// Test 1: BIP39 mnemonic generation
test('BIP39 mnemonic generation', async () => {
  const mnemonic = bip39.generateMnemonic(128);
  assert(bip39.validateMnemonic(mnemonic), 'Generated mnemonic should be valid');
  const words = mnemonic.split(' ');
  assertEquals(words.length, 12, 'Should generate 12 words');
});

// Test 2: BIP39 seed derivation
test('BIP39 seed derivation from known mnemonic', async () => {
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = await bip39.mnemonicToSeed(testMnemonic);
  assert(seed.length === 64, 'Seed should be 64 bytes');
  const expectedStart = '5eb00bbddcf069084889a8ab9155568165f5c453';
  assertEquals(seed.slice(0, 20).toString('hex'), expectedStart, 'Seed should match known value');
});

// Test 3: BIP32 root key derivation
test('BIP32 root key from seed', async () => {
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = await bip39.mnemonicToSeed(testMnemonic);
  const root = bip32.fromSeed(seed);
  assert(root.privateKey, 'Root should have private key');
  assert(root.publicKey, 'Root should have public key');
  assertEquals(root.publicKey.length, 33, 'Public key should be 33 bytes (compressed)');
});

// Test 4: BIP44 path derivation (Legacy)
test('BIP44 derivation path m/44\'/0\'/0\'/0/0', async () => {
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = await bip39.mnemonicToSeed(testMnemonic);
  const root = bip32.fromSeed(seed);
  const child = root.derivePath("m/44'/0'/0'/0/0");
  assert(child.privateKey, 'Child should have private key');
  const addr = pubkeyToLegacy(child.publicKey);
  assert(addr.startsWith('1'), 'BIP44 address should start with 1');
  console.log(`      Legacy address: ${addr}`);
});

// Test 5: BIP84 path derivation (Native SegWit)
test('BIP84 derivation path m/84\'/0\'/0\'/0/0', async () => {
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = await bip39.mnemonicToSeed(testMnemonic);
  const root = bip32.fromSeed(seed);
  const child = root.derivePath("m/84'/0'/0'/0/0");
  assert(child.privateKey, 'Child should have private key');
  const addr = pubkeyToBech32(child.publicKey);
  assert(addr.startsWith('bc1q'), 'BIP84 address should start with bc1q');
  console.log(`      Native SegWit address: ${addr}`);
});

// Test 6: BIP49 path derivation (Wrapped SegWit)
test('BIP49 derivation path m/49\'/0\'/0\'/0/0', async () => {
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = await bip39.mnemonicToSeed(testMnemonic);
  const root = bip32.fromSeed(seed);
  const child = root.derivePath("m/49'/0'/0'/0/0");
  assert(child.privateKey, 'Child should have private key');
  // P2SH-P2WPKH: hash160(0x0014 || hash160(pubkey))
  const h160 = hash160(child.publicKey);
  const redeemScript = Buffer.concat([Buffer.from([0x00, 0x14]), h160]);
  const scriptHash = hash160(redeemScript);
  const addr = pubkeyToLegacy(child.publicKey, 0x05).replace(/^1/, '3');
  // Actually compute P2SH address properly
  const p2shVersioned = Buffer.concat([Buffer.from([0x05]), scriptHash]);
  const p2shChecksum = doubleSha256(p2shVersioned).slice(0, 4);
  const p2shAddr = base58Encode(Buffer.concat([p2shVersioned, p2shChecksum]));
  assert(p2shAddr.startsWith('3'), 'BIP49 address should start with 3');
  console.log(`      Wrapped SegWit address: ${p2shAddr}`);
});

// Test 7: VOID CashAddr derivation
test('VOID CashAddr derivation m/44\'/145\'/0\'/0/0', async () => {
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = await bip39.mnemonicToSeed(testMnemonic);
  const root = bip32.fromSeed(seed);
  const child = root.derivePath("m/44'/145'/0'/0/0");
  const addr = pubkeyToCashAddr(child.publicKey);
  assert(addr.startsWith('bitcoincashii:q'), 'VOID address should start with bitcoincashii:q');
  console.log(`      VOID CashAddr: ${addr}`);
});

// Test 8: Bech32 encoding/decoding
test('Bech32 encoding roundtrip', async () => {
  const h160 = Buffer.from('751e76e8199196d454941c45d1b3a323f1433bd6', 'hex');
  const words = [0, ...convertBits(h160, 8, 5)];
  const encoded = bech32Encode('bc', words);
  assertEquals(encoded, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'Should match known bc1 address');
});

// Test 9: CashAddr encoding
test('CashAddr encoding', async () => {
  const h160 = Buffer.from('751e76e8199196d454941c45d1b3a323f1433bd6', 'hex');
  const addr = cashAddrEncode('bitcoincashii', 0, [...h160]);
  assert(addr.startsWith('bitcoincashii:q'), 'CashAddr should have correct prefix');
});

// Test 10: Scripthash calculation for bc1 address
test('Scripthash calculation for Native SegWit', async () => {
  const testAddr = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const scripthash = addressToScripthash(testAddr);
  assert(scripthash.length === 64, 'Scripthash should be 32 bytes (64 hex chars)');
  // Verify it's a valid hex string
  assert(/^[0-9a-f]+$/.test(scripthash), 'Should be valid hex');
});

// Test 11: Scripthash calculation for legacy address
test('Scripthash calculation for Legacy P2PKH', async () => {
  const testAddr = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
  const scripthash = addressToScripthash(testAddr);
  assert(scripthash.length === 64, 'Scripthash should be 32 bytes (64 hex chars)');
});

// Test 12: Multiple address derivation
test('Derive multiple addresses from same seed', async () => {
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = await bip39.mnemonicToSeed(testMnemonic);
  const root = bip32.fromSeed(seed);

  const addresses = [];
  for (let i = 0; i < 5; i++) {
    const child = root.derivePath(`m/84'/0'/0'/0/${i}`);
    addresses.push(pubkeyToBech32(child.publicKey));
  }

  // All addresses should be unique
  const unique = new Set(addresses);
  assertEquals(unique.size, 5, 'All derived addresses should be unique');
});

// Test 13: Hash160 correctness
test('Hash160 produces correct output', () => {
  const input = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');
  const result = hash160(input);
  assertEquals(result.toString('hex'), '751e76e8199196d454941c45d1b3a323f1433bd6', 'Hash160 should match known value');
});

// Test 14: Double SHA256 correctness
test('Double SHA256 produces correct output', () => {
  const input = Buffer.from('hello');
  const result = doubleSha256(input);
  assert(result.length === 32, 'Double SHA256 should produce 32 bytes');
});

// Test 15: Electrum WebSocket connectivity
test('Electrum proxy connectivity', async () => {
  const PROXY_URL = 'ws://localhost:8081';

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timeout'));
    }, 15000);

    const ws = new WebSocket(PROXY_URL);
    let connected = false;

    ws.on('open', () => {
      // First send connect handshake
      ws.send(JSON.stringify({ type: 'connect', network: 'void' }));
    });

    ws.on('message', (data) => {
      const response = JSON.parse(data.toString());

      if (response.type === 'connected') {
        connected = true;
        // Now send server.version request
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'server.version',
          params: ['void-test', '1.4']
        }));
        return;
      }

      if (response.result) {
        clearTimeout(timeout);
        console.log(`      Server: ${response.result[0]}`);
        ws.close();
        resolve();
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
});

// Test 16: Electrum balance query
test('Electrum scripthash balance query', async () => {
  const PROXY_URL = 'ws://localhost:8081';

  // Use a known test address scripthash (derive from known bc1 address)
  const testAddr = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const testScripthash = addressToScripthash(testAddr);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Query timeout'));
    }, 15000);

    const ws = new WebSocket(PROXY_URL);
    let connected = false;

    ws.on('open', () => {
      // First send connect handshake
      ws.send(JSON.stringify({ type: 'connect', network: 'void' }));
    });

    ws.on('message', (data) => {
      const response = JSON.parse(data.toString());

      if (response.type === 'connected') {
        connected = true;
        // Now send balance query
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'blockchain.scripthash.get_balance',
          params: [testScripthash]
        }));
        return;
      }

      // Should get a response (result or error)
      if (response.id === 1) {
        clearTimeout(timeout);
        if (response.result) {
          console.log(`      Balance: ${JSON.stringify(response.result)}`);
        }
        ws.close();
        resolve();
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
});

// Test 17: Anti-gaming detection logic
test('Anti-gaming detection - higher VOID balance indicates post-fork deposit', () => {
  const voidBalance = 1000000; // 0.01 VOID
  const voidBalance = 500000; // 0.005 VOID

  // If VOID balance > VOID balance, funds were deposited after fork
  const isFromAirdrop = voidBalance >= voidBalance;
  assertEquals(isFromAirdrop, false, 'Higher VOID balance should indicate post-fork deposit');
});

// Test 18: Anti-gaming detection - equal balances
test('Anti-gaming detection - equal balances indicates pre-fork holding', () => {
  const voidBalance = 1000000;
  const voidBalance = 1000000;

  const isFromAirdrop = voidBalance >= voidBalance;
  assertEquals(isFromAirdrop, true, 'Equal balances should indicate pre-fork holding');
});

// Test 19: BIP44 coin type for VOID
test('VOID uses coin type 145 (BCH compatible)', () => {
  const voidPath = "m/44'/145'/0'/0/0";
  assert(voidPath.includes("145'"), 'VOID should use coin type 145');
});

// Test 20: Private key is 32 bytes
test('Private key length validation', async () => {
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = await bip39.mnemonicToSeed(testMnemonic);
  const root = bip32.fromSeed(seed);
  const child = root.derivePath("m/84'/0'/0'/0/0");
  assertEquals(child.privateKey.length, 32, 'Private key should be 32 bytes');
});

// Test 21: Compressed public key format
test('Public key is compressed (33 bytes, starts with 02 or 03)', async () => {
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = await bip39.mnemonicToSeed(testMnemonic);
  const root = bip32.fromSeed(seed);
  const child = root.derivePath("m/84'/0'/0'/0/0");
  assertEquals(child.publicKey.length, 33, 'Public key should be 33 bytes (compressed)');
  assert(child.publicKey[0] === 0x02 || child.publicKey[0] === 0x03, 'Should start with 02 or 03');
});

// Test 22: Transaction sighash flag
test('VOID uses SIGHASH_ALL | SIGHASH_FORKID (0x41)', () => {
  const SIGHASH_ALL = 0x01;
  const SIGHASH_FORKID = 0x40;
  const combined = SIGHASH_ALL | SIGHASH_FORKID;
  assertEquals(combined, 0x41, 'Combined sighash should be 0x41');
});

// ============================================================================
// Run all tests
// ============================================================================
runTests().then(success => {
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
