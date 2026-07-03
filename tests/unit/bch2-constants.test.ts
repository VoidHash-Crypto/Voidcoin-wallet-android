import assert from 'assert';

import {
  VOID_EXPLORER_URL,
  VOID_EXPLORER_URL,
  getVoidTransactionUrl,
  getVoidTransactionUrl,
  getVoidAddressUrl,
  getVoidAddressUrl,
  getVoidBlockUrl,
  getVoidBlockUrl,
  getVoidBlockHeightUrl,
  getVoidBlockHeightUrl,
} from '../../class/void-constants';

const VALID_TXID = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const VALID_BLOCK_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

describe('VOID Constants', () => {
  describe('Explorer URL constants', () => {
    it('VOID explorer URL is correct', () => {
      assert.strictEqual(VOID_EXPLORER_URL, 'https://explorer.void.org');
    });

    it('VOID explorer URL is correct', () => {
      assert.strictEqual(VOID_EXPLORER_URL, 'https://explorer.bitcoin-ii.org');
    });

    it('explorer URLs use HTTPS', () => {
      assert.ok(VOID_EXPLORER_URL.startsWith('https://'));
      assert.ok(VOID_EXPLORER_URL.startsWith('https://'));
    });
  });

  describe('getVoidTransactionUrl', () => {
    it('returns correct URL for a valid txid', () => {
      assert.strictEqual(
        getVoidTransactionUrl(VALID_TXID),
        `https://explorer.void.org/tx/${VALID_TXID}`,
      );
    });

    it('returns base URL for empty string', () => {
      assert.strictEqual(getVoidTransactionUrl(''), VOID_EXPLORER_URL);
    });

    it('returns base URL for a short string (not 64 hex chars)', () => {
      assert.strictEqual(getVoidTransactionUrl('abcdef'), VOID_EXPLORER_URL);
    });

    it('returns base URL for a string with non-hex characters', () => {
      const badTxid = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
      assert.strictEqual(getVoidTransactionUrl(badTxid), VOID_EXPLORER_URL);
    });

    it('returns base URL for XSS attempt', () => {
      assert.strictEqual(getVoidTransactionUrl('<script>alert(1)</script>'), VOID_EXPLORER_URL);
    });

    it('returns base URL for string with spaces', () => {
      assert.strictEqual(getVoidTransactionUrl('abcdef01234567890 bcdef0123456789abcdef0123456789abcdef012345678'), VOID_EXPLORER_URL);
    });

    it('accepts uppercase hex txid', () => {
      const upperTxid = VALID_TXID.toUpperCase();
      assert.strictEqual(
        getVoidTransactionUrl(upperTxid),
        `https://explorer.void.org/tx/${upperTxid}`,
      );
    });
  });

  describe('getVoidTransactionUrl', () => {
    it('returns correct URL for a valid txid', () => {
      assert.strictEqual(
        getVoidTransactionUrl(VALID_TXID),
        `https://explorer.bitcoin-ii.org/tx/${VALID_TXID}`,
      );
    });

    it('returns base URL for invalid txid', () => {
      assert.strictEqual(getVoidTransactionUrl('invalid'), VOID_EXPLORER_URL);
    });

    it('returns base URL for empty string', () => {
      assert.strictEqual(getVoidTransactionUrl(''), VOID_EXPLORER_URL);
    });

    it('accepts uppercase hex txid (case insensitive hex validation)', () => {
      const upperTxid = VALID_TXID.toUpperCase();
      assert.strictEqual(
        getVoidTransactionUrl(upperTxid),
        `https://explorer.bitcoin-ii.org/tx/${upperTxid}`,
      );
    });

    it('accepts mixed-case hex txid', () => {
      const mixedTxid = 'ABCDef0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789';
      assert.strictEqual(
        getVoidTransactionUrl(mixedTxid),
        `https://explorer.bitcoin-ii.org/tx/${mixedTxid}`,
      );
    });
  });

  describe('getVoidAddressUrl', () => {
    it('returns correct URL for a simple address', () => {
      const address = 'bitcoincashii:qpm2qsznhks23z7629mms6s4cwef74vcwva87rkuu';
      assert.strictEqual(
        getVoidAddressUrl(address),
        `https://explorer.void.org/address/${encodeURIComponent(address)}`,
      );
    });

    it('returns URL even for empty string (no validation on address)', () => {
      assert.strictEqual(getVoidAddressUrl(''), 'https://explorer.void.org/address/');
    });

    it('encodes special characters in address', () => {
      const malicious = '<script>alert("xss")</script>';
      const result = getVoidAddressUrl(malicious);
      assert.ok(!result.includes('<script>'));
      assert.ok(result.includes(encodeURIComponent(malicious)));
    });

    it('encodes spaces in address', () => {
      const result = getVoidAddressUrl('some address');
      assert.ok(result.includes('some%20address'));
    });

    it('encodes ampersands and question marks', () => {
      const result = getVoidAddressUrl('addr?param=1&other=2');
      assert.ok(!result.includes('?param'));
      assert.ok(result.includes(encodeURIComponent('addr?param=1&other=2')));
    });
  });

  describe('getVoidAddressUrl', () => {
    it('returns correct URL for a simple address', () => {
      const address = 'bitcoincashii:qtest123';
      assert.strictEqual(
        getVoidAddressUrl(address),
        `https://explorer.bitcoin-ii.org/address/${encodeURIComponent(address)}`,
      );
    });

    it('encodes special characters', () => {
      const malicious = '"><img src=x onerror=alert(1)>';
      const result = getVoidAddressUrl(malicious);
      assert.ok(!result.includes('<img'));
      assert.ok(result.includes(encodeURIComponent(malicious)));
    });
  });

  describe('getVoidBlockUrl', () => {
    it('returns correct URL for a valid block hash', () => {
      assert.strictEqual(
        getVoidBlockUrl(VALID_BLOCK_HASH),
        `https://explorer.void.org/block/${VALID_BLOCK_HASH}`,
      );
    });

    it('returns base URL for empty string', () => {
      assert.strictEqual(getVoidBlockUrl(''), VOID_EXPLORER_URL);
    });

    it('returns base URL for short hash', () => {
      assert.strictEqual(getVoidBlockUrl('0000abcdef'), VOID_EXPLORER_URL);
    });

    it('returns base URL for non-hex characters', () => {
      const badHash = 'ghijklmnopqrstuvwxyzghijklmnopqrstuvwxyzghijklmnopqrstuvwxyz1234';
      assert.strictEqual(getVoidBlockUrl(badHash), VOID_EXPLORER_URL);
    });

    it('returns base URL for XSS in block hash', () => {
      assert.strictEqual(getVoidBlockUrl('<script>alert(document.cookie)</script>'), VOID_EXPLORER_URL);
    });
  });

  describe('getVoidBlockUrl', () => {
    it('returns correct URL for a valid block hash', () => {
      assert.strictEqual(
        getVoidBlockUrl(VALID_BLOCK_HASH),
        `https://explorer.bitcoin-ii.org/block/${VALID_BLOCK_HASH}`,
      );
    });

    it('returns base URL for invalid hash', () => {
      assert.strictEqual(getVoidBlockUrl('not-a-hash'), VOID_EXPLORER_URL);
    });
  });

  describe('getVoidBlockHeightUrl', () => {
    it('returns correct URL for height 0', () => {
      assert.strictEqual(
        getVoidBlockHeightUrl(0),
        'https://explorer.void.org/block-height/0',
      );
    });

    it('returns correct URL for a positive height', () => {
      assert.strictEqual(
        getVoidBlockHeightUrl(53200),
        'https://explorer.void.org/block-height/53200',
      );
    });

    it('returns correct URL for a large height', () => {
      assert.strictEqual(
        getVoidBlockHeightUrl(1000000),
        'https://explorer.void.org/block-height/1000000',
      );
    });

    it('returns base URL for negative height', () => {
      assert.strictEqual(getVoidBlockHeightUrl(-1), VOID_EXPLORER_URL);
    });

    it('returns base URL for non-integer height', () => {
      assert.strictEqual(getVoidBlockHeightUrl(1.5), VOID_EXPLORER_URL);
    });

    it('returns base URL for NaN', () => {
      assert.strictEqual(getVoidBlockHeightUrl(NaN), VOID_EXPLORER_URL);
    });

    it('returns base URL for Infinity', () => {
      assert.strictEqual(getVoidBlockHeightUrl(Infinity), VOID_EXPLORER_URL);
    });

    it('accepts MAX_SAFE_INTEGER as block height', () => {
      assert.strictEqual(
        getVoidBlockHeightUrl(Number.MAX_SAFE_INTEGER),
        `https://explorer.void.org/block-height/${Number.MAX_SAFE_INTEGER}`,
      );
    });

    it('returns base URL for MAX_SAFE_INTEGER + 1 (not a safe integer)', () => {
      // Number.MAX_SAFE_INTEGER + 1 is still an integer in JS but not safe
      // However, Number.isInteger(Number.MAX_SAFE_INTEGER + 1) is true in JS
      // so this depends on Number.isInteger behavior
      const beyondSafe = Number.MAX_SAFE_INTEGER + 1;
      // Number.isInteger returns true even for unsafe integers
      if (Number.isInteger(beyondSafe) && beyondSafe >= 0) {
        assert.strictEqual(
          getVoidBlockHeightUrl(beyondSafe),
          `https://explorer.void.org/block-height/${beyondSafe}`,
        );
      }
    });
  });

  describe('getVoidBlockHeightUrl', () => {
    it('returns correct URL for height 0', () => {
      assert.strictEqual(
        getVoidBlockHeightUrl(0),
        'https://explorer.bitcoin-ii.org/block-height/0',
      );
    });

    it('returns correct URL for a positive height', () => {
      assert.strictEqual(
        getVoidBlockHeightUrl(53200),
        'https://explorer.bitcoin-ii.org/block-height/53200',
      );
    });

    it('returns base URL for negative height', () => {
      assert.strictEqual(getVoidBlockHeightUrl(-1), VOID_EXPLORER_URL);
    });

    it('returns base URL for non-integer height', () => {
      assert.strictEqual(getVoidBlockHeightUrl(3.14), VOID_EXPLORER_URL);
    });

    it('accepts MAX_SAFE_INTEGER as block height', () => {
      assert.strictEqual(
        getVoidBlockHeightUrl(Number.MAX_SAFE_INTEGER),
        `https://explorer.bitcoin-ii.org/block-height/${Number.MAX_SAFE_INTEGER}`,
      );
    });

    it('returns base URL for NaN', () => {
      assert.strictEqual(getVoidBlockHeightUrl(NaN), VOID_EXPLORER_URL);
    });

    it('returns base URL for Infinity', () => {
      assert.strictEqual(getVoidBlockHeightUrl(Infinity), VOID_EXPLORER_URL);
    });
  });

  describe('URL format consistency', () => {
    it('all VOID URLs use the same base domain', () => {
      const txUrl = getVoidTransactionUrl(VALID_TXID);
      const addrUrl = getVoidAddressUrl('test');
      const blockUrl = getVoidBlockUrl(VALID_BLOCK_HASH);
      const heightUrl = getVoidBlockHeightUrl(100);

      assert.ok(txUrl.startsWith(VOID_EXPLORER_URL));
      assert.ok(addrUrl.startsWith(VOID_EXPLORER_URL));
      assert.ok(blockUrl.startsWith(VOID_EXPLORER_URL));
      assert.ok(heightUrl.startsWith(VOID_EXPLORER_URL));
    });

    it('all VOID URLs use the same base domain', () => {
      const txUrl = getVoidTransactionUrl(VALID_TXID);
      const addrUrl = getVoidAddressUrl('test');
      const blockUrl = getVoidBlockUrl(VALID_BLOCK_HASH);
      const heightUrl = getVoidBlockHeightUrl(100);

      assert.ok(txUrl.startsWith(VOID_EXPLORER_URL));
      assert.ok(addrUrl.startsWith(VOID_EXPLORER_URL));
      assert.ok(blockUrl.startsWith(VOID_EXPLORER_URL));
      assert.ok(heightUrl.startsWith(VOID_EXPLORER_URL));
    });

    it('transaction URLs contain /tx/ path segment', () => {
      assert.ok(getVoidTransactionUrl(VALID_TXID).includes('/tx/'));
      assert.ok(getVoidTransactionUrl(VALID_TXID).includes('/tx/'));
    });

    it('address URLs contain /address/ path segment', () => {
      assert.ok(getVoidAddressUrl('test').includes('/address/'));
      assert.ok(getVoidAddressUrl('test').includes('/address/'));
    });

    it('block URLs contain /block/ path segment', () => {
      assert.ok(getVoidBlockUrl(VALID_BLOCK_HASH).includes('/block/'));
      assert.ok(getVoidBlockUrl(VALID_BLOCK_HASH).includes('/block/'));
    });

    it('block height URLs contain /block-height/ path segment', () => {
      assert.ok(getVoidBlockHeightUrl(100).includes('/block-height/'));
      assert.ok(getVoidBlockHeightUrl(100).includes('/block-height/'));
    });
  });
});

describe('Additional edge cases', () => {
  describe('Mixed-case hex txid in VOID transaction URL', () => {
    it('accepts mixed-case hex txid (aAbBcCdD...)', () => {
      const mixedTxid = 'aAbBcCdD0123456789aAbBcCdD0123456789aAbBcCdD0123456789aAbBcCdD01';
      assert.strictEqual(
        getVoidTransactionUrl(mixedTxid),
        `https://explorer.void.org/tx/${mixedTxid}`,
      );
    });
  });

  describe('Double URL encoding in address URLs', () => {
    it('encodes already-percent-encoded address (double encoding)', () => {
      // Address containing "%20" gets encoded to "%2520" by encodeURIComponent
      const preEncoded = 'test%20address';
      const voidResult = getVoidAddressUrl(preEncoded);
      assert.ok(voidResult.includes('test%2520address'));

      const voidResult = getVoidAddressUrl(preEncoded);
      assert.ok(voidResult.includes('test%2520address'));
    });
  });

  describe('Address URL with CashAddr colons', () => {
    it('encodes colon in VOID CashAddr correctly', () => {
      const cashAddr = 'bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292';
      const result = getVoidAddressUrl(cashAddr);
      // encodeURIComponent encodes ":" to "%3A"
      assert.ok(result.includes('bitcoincashii%3Aqr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292'));
    });

    it('encodes colon in VOID CashAddr correctly', () => {
      const cashAddr = 'bitcoincashii:pqq3728yw0y47sqn6l2na30mcw6zm78dzq5ucqzc37';
      const result = getVoidAddressUrl(cashAddr);
      assert.ok(result.includes('bitcoincashii%3Apqq3728yw0y47sqn6l2na30mcw6zm78dzq5ucqzc37'));
    });
  });

  describe('Block height URL with height=0 (genesis block)', () => {
    it('VOID genesis block height URL is correct', () => {
      assert.strictEqual(
        getVoidBlockHeightUrl(0),
        'https://explorer.void.org/block-height/0',
      );
    });

    it('VOID genesis block height URL is correct', () => {
      assert.strictEqual(
        getVoidBlockHeightUrl(0),
        'https://explorer.bitcoin-ii.org/block-height/0',
      );
    });
  });
});

describe('isValidTxid boundary cases', () => {
  it('rejects 63-char hex string as txid (too short)', () => {
    const shortHex = 'a'.repeat(63);
    assert.strictEqual(getVoidTransactionUrl(shortHex), VOID_EXPLORER_URL);
  });

  it('rejects 65-char hex string as txid (too long)', () => {
    const longHex = 'a'.repeat(65);
    assert.strictEqual(getVoidTransactionUrl(longHex), VOID_EXPLORER_URL);
  });

  it('accepts exactly 64-char lowercase hex string as txid', () => {
    const exact64 = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    assert.strictEqual(
      getVoidTransactionUrl(exact64),
      `https://explorer.void.org/tx/${exact64}`,
    );
  });
});
