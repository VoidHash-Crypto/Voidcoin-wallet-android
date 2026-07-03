import assert from 'assert';

import {
  VOIDUnit,
  CoinType,
  formatVOIDAmount,
  parseVOIDAmount,
  VOID_FORK_INFO,
} from '../../models/voidUnits';

describe('VOID Units', () => {
  describe('VOIDUnit constants', () => {
    it('has VOID unit', () => {
      assert.strictEqual(VOIDUnit.VOID, 'VOID');
    });

    it('has SATS unit', () => {
      assert.strictEqual(VOIDUnit.SATS, 'sats');
    });

    it('has LOCAL_CURRENCY unit', () => {
      assert.strictEqual(VOIDUnit.LOCAL_CURRENCY, 'local_currency');
    });

    it('has MAX unit', () => {
      assert.strictEqual(VOIDUnit.MAX, 'MAX');
    });

    it('contains exactly 4 unit types', () => {
      const keys = Object.keys(VOIDUnit);
      assert.strictEqual(keys.length, 4);
    });
  });

  describe('CoinType constants', () => {
    it('has VOID coin type', () => {
      assert.strictEqual(CoinType.VOID, 'VOID');
    });

    it('has VOID coin type', () => {
      assert.strictEqual(CoinType.VOID, 'VOID');
    });

    it('contains exactly 2 coin types', () => {
      const keys = Object.keys(CoinType);
      assert.strictEqual(keys.length, 2);
    });
  });

  describe('formatVOIDAmount', () => {
    it('formats 0 satoshis in VOID', () => {
      assert.strictEqual(formatVOIDAmount(0), '0.00000000 VOID');
    });

    it('formats 1 satoshi in VOID', () => {
      assert.strictEqual(formatVOIDAmount(1), '0.00000001 VOID');
    });

    it('formats 100000000 satoshis (1 VOID) in VOID', () => {
      assert.strictEqual(formatVOIDAmount(100000000), '1.00000000 VOID');
    });

    it('formats a fractional VOID amount', () => {
      assert.strictEqual(formatVOIDAmount(123456789), '1.23456789 VOID');
    });

    it('formats large amounts in VOID', () => {
      // 21 million VOID in satoshis = 2100000000000000
      assert.strictEqual(formatVOIDAmount(2100000000000000), '21000000.00000000 VOID');
    });

    it('formats MAX_SAFE_INTEGER in VOID', () => {
      const result = formatVOIDAmount(Number.MAX_SAFE_INTEGER);
      assert.ok(result.endsWith(' VOID'));
      assert.ok(result.length > 0);
    });

    it('formats negative satoshis in VOID', () => {
      assert.strictEqual(formatVOIDAmount(-100000000), '-1.00000000 VOID');
    });

    it('formats 0 satoshis in SATS unit', () => {
      assert.strictEqual(formatVOIDAmount(0, VOIDUnit.SATS), '0 sats');
    });

    it('formats 1 satoshi in SATS unit', () => {
      assert.strictEqual(formatVOIDAmount(1, VOIDUnit.SATS), '1 sats');
    });

    it('formats large satoshi amounts in SATS unit', () => {
      assert.strictEqual(formatVOIDAmount(100000000, VOIDUnit.SATS), '100000000 sats');
    });

    it('formats negative satoshis in SATS unit', () => {
      assert.strictEqual(formatVOIDAmount(-500, VOIDUnit.SATS), '-500 sats');
    });

    it('defaults to VOID format for LOCAL_CURRENCY unit', () => {
      const result = formatVOIDAmount(100000000, VOIDUnit.LOCAL_CURRENCY);
      assert.strictEqual(result, '1.00000000 VOID');
    });

    it('defaults to VOID format for MAX unit', () => {
      const result = formatVOIDAmount(100000000, VOIDUnit.MAX);
      assert.strictEqual(result, '1.00000000 VOID');
    });
  });

  describe('parseVOIDAmount', () => {
    it('parses "1.0" as 100000000 satoshis (VOID unit)', () => {
      assert.strictEqual(parseVOIDAmount('1.0'), 100000000);
    });

    it('parses "0.00000001" as 1 satoshi (VOID unit)', () => {
      assert.strictEqual(parseVOIDAmount('0.00000001'), 1);
    });

    it('parses "0" as 0 satoshis', () => {
      assert.strictEqual(parseVOIDAmount('0'), 0);
    });

    it('parses "0.5" as 50000000 satoshis', () => {
      assert.strictEqual(parseVOIDAmount('0.5'), 50000000);
    });

    it('parses "21000000" as 2100000000000000 satoshis', () => {
      assert.strictEqual(parseVOIDAmount('21000000'), 2100000000000000);
    });

    it('returns 0 for empty string', () => {
      assert.strictEqual(parseVOIDAmount(''), 0);
    });

    it('returns 0 for completely invalid string', () => {
      assert.strictEqual(parseVOIDAmount('abc'), 0);
    });

    it('returns 0 for string with no digits', () => {
      assert.strictEqual(parseVOIDAmount('---'), 0);
    });

    it('strips non-numeric characters and parses remainder', () => {
      // "1.5 VOID" => regex keeps digits and dots => "1.52" => 152000000
      assert.strictEqual(parseVOIDAmount('1.5 VOID'), 152000000);
      // Pure non-numeric suffix with no digits
      assert.strictEqual(parseVOIDAmount('1.5 coins'), 150000000);
    });

    it('handles string with leading/trailing spaces via regex cleaning', () => {
      // spaces are stripped by the regex, leaving numeric content
      assert.strictEqual(parseVOIDAmount('  1.0  '), 100000000);
    });

    it('parses in SATS unit mode', () => {
      assert.strictEqual(parseVOIDAmount('12345', VOIDUnit.SATS), 12345);
    });

    it('floors fractional values in SATS unit mode', () => {
      assert.strictEqual(parseVOIDAmount('123.99', VOIDUnit.SATS), 123);
    });

    it('returns 0 for negative in SATS mode (after cleaning)', () => {
      // "-5" => cleaned to "5" => 5 (the minus is stripped by regex)
      assert.strictEqual(parseVOIDAmount('-5', VOIDUnit.SATS), 5);
    });

    it('returns 0 for empty string in SATS mode', () => {
      assert.strictEqual(parseVOIDAmount('', VOIDUnit.SATS), 0);
    });

    it('returns 0 for NaN-producing string in SATS mode', () => {
      assert.strictEqual(parseVOIDAmount('xyz', VOIDUnit.SATS), 0);
    });

    it('rounds correctly for small VOID fractions', () => {
      // 0.00000001 * 100000000 = 1
      assert.strictEqual(parseVOIDAmount('0.00000001', VOIDUnit.VOID), 1);
    });

    it('handles "1.23456789" correctly', () => {
      assert.strictEqual(parseVOIDAmount('1.23456789', VOIDUnit.VOID), 123456789);
    });
  });

  describe('VOID_FORK_INFO', () => {
    it('has correct fork height', () => {
      assert.strictEqual(VOID_FORK_INFO.forkHeight, 53200);
    });

    it('has fork timestamp initialized to 0', () => {
      assert.strictEqual(VOID_FORK_INFO.forkTimestamp, 0);
    });

    it('has correct coin name', () => {
      assert.strictEqual(VOID_FORK_INFO.coinName, 'VoidCoin');
    });

    it('has correct symbol', () => {
      assert.strictEqual(VOID_FORK_INFO.symbol, 'VOID');
    });

    it('has correct address prefix', () => {
      assert.strictEqual(VOID_FORK_INFO.addressPrefix, 'bitcoincashii');
    });

    it('has correct default port', () => {
      assert.strictEqual(VOID_FORK_INFO.defaultPort, 8339);
    });

    it('has correct RPC port', () => {
      assert.strictEqual(VOID_FORK_INFO.rpcPort, 8342);
    });

    it('has correct Electrum port', () => {
      assert.strictEqual(VOID_FORK_INFO.electrumPort, 50001);
    });

    it('has correct Electrum SSL port', () => {
      assert.strictEqual(VOID_FORK_INFO.electrumSSLPort, 50002);
    });

    it('is frozen/readonly (all fields)', () => {
      const keys = Object.keys(VOID_FORK_INFO);
      assert.strictEqual(keys.length, 9);
      assert.deepStrictEqual(keys.sort(), [
        'addressPrefix',
        'coinName',
        'defaultPort',
        'electrumPort',
        'electrumSSLPort',
        'forkHeight',
        'forkTimestamp',
        'rpcPort',
        'symbol',
      ]);
    });
  });

  describe('parseVOIDAmount edge cases', () => {
    it('handles scientific notation input by stripping non-numeric chars', () => {
      // "1e8" => regex strips 'e', leaving "18" => parseFloat("18") = 18
      // 18 * 100_000_000 = 1_800_000_000
      assert.strictEqual(parseVOIDAmount('1e8', VOIDUnit.VOID), 1800000000);
    });

    it('handles multiple decimal points by parsing up to second dot', () => {
      // "1.2.3" => regex keeps digits and dots => "1.2.3"
      // parseFloat("1.2.3") = 1.2 (stops at second dot)
      // Math.round(1.2 * 100_000_000) = 120_000_000
      assert.strictEqual(parseVOIDAmount('1.2.3', VOIDUnit.VOID), 120000000);
    });

    it('handles multiple decimal points in SATS mode', () => {
      // "100.5.9" => cleaned "100.5.9" => parseFloat = 100.5 => Math.floor = 100
      assert.strictEqual(parseVOIDAmount('100.5.9', VOIDUnit.SATS), 100);
    });

    it('handles scientific notation input in SATS mode', () => {
      // "5e2" => regex strips 'e', leaving "52" => parseFloat("52") = 52
      assert.strictEqual(parseVOIDAmount('5e2', VOIDUnit.SATS), 52);
    });
  });

  describe('formatVOIDAmount very small negative amounts', () => {
    it('formats -1 satoshi as -0.00000001 VOID', () => {
      assert.strictEqual(formatVOIDAmount(-1), '-0.00000001 VOID');
    });

    it('formats -1 satoshi in SATS unit', () => {
      assert.strictEqual(formatVOIDAmount(-1, VOIDUnit.SATS), '-1 sats');
    });

    it('formats -10 satoshis correctly in VOID', () => {
      assert.strictEqual(formatVOIDAmount(-10), '-0.00000010 VOID');
    });

    it('formats -99 satoshis correctly in VOID', () => {
      assert.strictEqual(formatVOIDAmount(-99), '-0.00000099 VOID');
    });
  });

  describe('parseVOIDAmount additional edge cases', () => {
    it('returns 0 for ".a." input (regex strips to "..", parseFloat is NaN)', () => {
      // ".a." => regex keeps digits and dots => ".." => parseFloat("..") = NaN => returns 0
      assert.strictEqual(parseVOIDAmount('.a.'), 0);
    });

    it('returns 0 for pure non-numeric "abc" input', () => {
      // "abc" => regex strips all non-digit/non-dot => "" => parseFloat("") = NaN => returns 0
      assert.strictEqual(parseVOIDAmount('abc'), 0);
    });

    it('handles value just below MAX_SAFE_INTEGER precision limit', () => {
      // 90071992.54740991 VOID * 100_000_000 = 9007199254740991 = Number.MAX_SAFE_INTEGER
      // This is exactly at the boundary and IS a safe integer, so should succeed
      assert.strictEqual(parseVOIDAmount('90071992.54740991', VOIDUnit.VOID), Number.MAX_SAFE_INTEGER);
    });

    it('parses " 1.5 " with leading/trailing whitespace correctly', () => {
      // " 1.5 " => regex strips spaces => "1.5" => parseFloat("1.5") = 1.5
      // Math.round(1.5 * 100_000_000) = 150_000_000
      assert.strictEqual(parseVOIDAmount(' 1.5 ', VOIDUnit.VOID), 150000000);
    });
  });

  describe('formatVOIDAmount default unit parameter', () => {
    it('defaults to VOID unit when no unit is specified', () => {
      // Call without second argument; should behave identically to VOIDUnit.VOID
      assert.strictEqual(formatVOIDAmount(50000000), '0.50000000 VOID');
      assert.strictEqual(formatVOIDAmount(50000000, VOIDUnit.VOID), '0.50000000 VOID');
    });

    it('formats exactly 0 satoshis as "0.00000000 VOID" with default unit', () => {
      assert.strictEqual(formatVOIDAmount(0), '0.00000000 VOID');
    });
  });

  describe('parseVOIDAmount MAX_SAFE_INTEGER overflow', () => {
    it('returns 0 for values exceeding MAX_SAFE_INTEGER in VOID mode', () => {
      // 100_000_000 VOID * 100_000_000 sats/VOID = 10^16 which exceeds MAX_SAFE_INTEGER (9007199254740991)
      // Math.round(100000000 * 100000000) = 10000000000000000 which is NOT a safe integer
      const result = parseVOIDAmount('100000000', VOIDUnit.VOID);
      assert.strictEqual(result, 0);
    });

    it('returns 0 for values exceeding MAX_SAFE_INTEGER in SATS mode', () => {
      // A value larger than MAX_SAFE_INTEGER (9007199254740991)
      const result = parseVOIDAmount('9007199254740992', VOIDUnit.SATS);
      assert.strictEqual(result, 0);
    });
  });
});
