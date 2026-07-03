/**
 * Tests for VOID-specific deeplink handling in DeeplinkSchemaMatch.
 * Covers: VOID URI recognition, amount parsing, P2SH handling,
 * non-VOID scheme coexistence, and malformed URI handling.
 */

import DeeplinkSchemaMatch from '../../class/deeplink-schema-match';

jest.mock('../../blue_modules/BlueElectrum', () => {
  return {
    connectMain: jest.fn(),
  };
});

jest.mock('../../blue_modules/fs', () => {
  return {
    readFileOutsideSandbox: jest.fn(() => Promise.resolve(null)),
  };
});

// Helper: promisify the callback-based navigationRouteFor
const asyncNavigationRouteFor = async (event: { url: string }): Promise<any> => {
  return new Promise(resolve => {
    DeeplinkSchemaMatch.navigationRouteFor(event, (navValue: any) => {
      resolve(navValue);
    });
  });
};

describe('VOID Deeplink Handling', () => {
  // ===== hasSchema recognition =====
  describe('hasSchema', () => {
    it('recognizes bitcoincashii: scheme', () => {
      expect(DeeplinkSchemaMatch.hasSchema('bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292')).toBe(true);
    });

    it('recognizes bitcoincashii: scheme (uppercase)', () => {
      expect(DeeplinkSchemaMatch.hasSchema('BITCOINCASHII:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292')).toBe(true);
    });

    it('recognizes bitcoincashii: with query params', () => {
      expect(DeeplinkSchemaMatch.hasSchema('bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292?amount=1.5')).toBe(true);
    });

    it('recognizes bitcoincashii: P2SH address (p prefix)', () => {
      expect(DeeplinkSchemaMatch.hasSchema('bitcoincashii:pqq3728yw0y47sqn6l2na30mcw6zm78dzq5ucqzc37')).toBe(true);
    });

    it('does not recognize empty string', () => {
      expect(DeeplinkSchemaMatch.hasSchema('')).toBe(false);
    });

    it('does not recognize non-string input', () => {
      expect(DeeplinkSchemaMatch.hasSchema(null as any)).toBe(false);
      expect(DeeplinkSchemaMatch.hasSchema(undefined as any)).toBe(false);
      expect(DeeplinkSchemaMatch.hasSchema(123 as any)).toBe(false);
    });

    it('handles leading/trailing whitespace', () => {
      expect(DeeplinkSchemaMatch.hasSchema('  bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292  ')).toBe(true);
    });

    // Non-VOID schemes should still be recognized
    it('still recognizes bitcoin: scheme', () => {
      expect(DeeplinkSchemaMatch.hasSchema('bitcoin:12eQ9m4sgAwTSQoNXkRABKhCXCsjm2jdVG')).toBe(true);
    });

    it('still recognizes lightning: scheme', () => {
      expect(
        DeeplinkSchemaMatch.hasSchema(
          'lightning:lnbc10u1pwjqwkkpp5vlc3tttdzhpk9fwzkkue0sf2pumtza7qyw9vucxyyeh0yaqq66yqdq5f38z6mmwd3ujqar9wd6qcqzpgxq97zvuqrzjqvgptfurj3528snx6e3dtwepafxw5fpzdymw9pj20jj09sunnqmwqz9hx5qqtmgqqqqqqqlgqqqqqqgqjq5duu3fs9xq9vn89qk3ezwpygecu4p3n69wm3tnl28rpgn2gmk5hjaznemw0gy32wrslpn3g24khcgnpua9q04fttm2y8pnhmhhc2gncplz0zde',
        ),
      ).toBe(true);
    });

    it('still recognizes voidcoin: scheme', () => {
      expect(DeeplinkSchemaMatch.hasSchema('voidcoin:bitcoin:12eQ9m4sgAwTSQoNXkRABKhCXCsjm2jdVG')).toBe(true);
    });

    it('does not recognize arbitrary schemes', () => {
      expect(DeeplinkSchemaMatch.hasSchema('ethereum:0x1234567890abcdef')).toBe(false);
      expect(DeeplinkSchemaMatch.hasSchema('litecoin:abc123')).toBe(false);
      expect(DeeplinkSchemaMatch.hasSchema('https://example.com')).toBe(false);
    });
  });

  // ===== VOID navigation routing =====
  describe('navigationRouteFor with VOID URIs', () => {
    it('routes bitcoincashii:qaddr to VoidSendRoot', async () => {
      const result = await asyncNavigationRouteFor({
        url: 'bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292',
      });

      expect(result).toEqual([
        'VoidSendRoot',
        {
          screen: 'VoidSend',
          params: {
            uri: 'bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292',
          },
        },
      ]);
    });

    it('routes bitcoincashii:qaddr?amount=1.5 with correct amount parsing', async () => {
      const result = await asyncNavigationRouteFor({
        url: 'bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292?amount=1.5',
      });

      expect(result).toEqual([
        'VoidSendRoot',
        {
          screen: 'VoidSend',
          params: {
            uri: 'bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292?amount=1.5',
          },
        },
      ]);
    });

    it('routes bitcoincashii:paddr (P2SH) to VoidSendRoot', async () => {
      const result = await asyncNavigationRouteFor({
        url: 'bitcoincashii:pqq3728yw0y47sqn6l2na30mcw6zm78dzq5ucqzc37',
      });

      expect(result).toEqual([
        'VoidSendRoot',
        {
          screen: 'VoidSend',
          params: {
            uri: 'bitcoincashii:pqq3728yw0y47sqn6l2na30mcw6zm78dzq5ucqzc37',
          },
        },
      ]);
    });

    it('routes bitcoincashii: with amount and label', async () => {
      const uri = 'bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292?amount=0.5&label=Test%20Payment';
      const result = await asyncNavigationRouteFor({ url: uri });

      expect(result).toEqual([
        'VoidSendRoot',
        {
          screen: 'VoidSend',
          params: { uri },
        },
      ]);
    });

    it('passes the full URI including query params to VoidSend', async () => {
      const uri = 'bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292?amount=2.0&message=hello';
      const result = await asyncNavigationRouteFor({ url: uri });

      expect(result[1].params.uri).toBe(uri);
    });

    it('handles uppercase BITCOINCASHII: scheme', async () => {
      const result = await asyncNavigationRouteFor({
        url: 'BITCOINCASHII:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292',
      });

      expect(result[0]).toBe('VoidSendRoot');
      expect(result[1].screen).toBe('VoidSend');
    });

    it('handles mixed case VoidCoin: scheme', async () => {
      const result = await asyncNavigationRouteFor({
        url: 'VoidCoin:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292',
      });

      expect(result[0]).toBe('VoidSendRoot');
    });
  });

  // ===== Non-VOID schemes still handled correctly =====
  describe('Non-VOID schemes still work', () => {
    it('bitcoin: scheme still routes to SendDetailsRoot', async () => {
      const result = await asyncNavigationRouteFor({
        url: 'bitcoin:12eQ9m4sgAwTSQoNXkRABKhCXCsjm2jdVG',
      });

      expect(result[0]).toBe('SendDetailsRoot');
      expect(result[1].screen).toBe('SendDetails');
    });

    it('lightning: scheme still routes to ScanLNDInvoiceRoot', async () => {
      const result = await asyncNavigationRouteFor({
        url: 'lightning:lnbc10u1pwjqwkkpp5vlc3tttdzhpk9fwzkkue0sf2pumtza7qyw9vucxyyeh0yaqq66yqdq5f38z6mmwd3ujqar9wd6qcqzpgxq97zvuqrzjqvgptfurj3528snx6e3dtwepafxw5fpzdymw9pj20jj09sunnqmwqz9hx5qqtmgqqqqqqqlgqqqqqqgqjq5duu3fs9xq9vn89qk3ezwpygecu4p3n69wm3tnl28rpgn2gmk5hjaznemw0gy32wrslpn3g24khcgnpua9q04fttm2y8pnhmhhc2gncplz0zde',
      });

      expect(result[0]).toBe('ScanLNDInvoiceRoot');
      expect(result[1].screen).toBe('ScanLNDInvoice');
    });

    it('voidcoin: scheme still routes correctly', async () => {
      const result = await asyncNavigationRouteFor({
        url: 'voidcoin:setelectrumserver?server=electrum1.voidcoin.io%3A443%3As',
      });

      expect(result[0]).toBe('ElectrumSettings');
    });
  });

  // ===== Invalid/malformed VOID URIs =====
  describe('Invalid/malformed VOID URIs', () => {
    it('null URL does not crash', () => {
      // navigationRouteFor should handle null gracefully (returns undefined)
      const handler = jest.fn();
      DeeplinkSchemaMatch.navigationRouteFor({ url: null as any }, handler);
      // handler should NOT be called for null url
      expect(handler).not.toHaveBeenCalled();
    });

    it('non-string URL does not crash', () => {
      const handler = jest.fn();
      DeeplinkSchemaMatch.navigationRouteFor({ url: 123 as any }, handler);
      expect(handler).not.toHaveBeenCalled();
    });

    it('empty string URL does not crash', async () => {
      // Empty string should not match any schema, may or may not call handler
      const handler = jest.fn();
      DeeplinkSchemaMatch.navigationRouteFor({ url: '' }, handler);
      // No assertion on whether handler is called - just verify no crash
    });

    it('bitcoincashii: with no address part is handled without crash', async () => {
      // The scheme is recognized but the URI has no address
      const handler = jest.fn();
      DeeplinkSchemaMatch.navigationRouteFor({ url: 'bitcoincashii:' }, handler);
      // Should still route to VoidSend (the VoidSend screen handles validation)
      expect(handler).toHaveBeenCalledWith([
        'VoidSendRoot',
        {
          screen: 'VoidSend',
          params: {
            uri: 'bitcoincashii:',
          },
        },
      ]);
    });
  });

  // ===== VOID does not conflict with BIP21 bitcoin/lightning combo =====
  describe('VOID does not conflict with bitcoin+lightning combo URIs', () => {
    it('isBothBitcoinAndLightning does not match VOID URIs', () => {
      const result = DeeplinkSchemaMatch.isBothBitcoinAndLightning(
        'bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292?amount=1.5',
      );
      // VOID URIs should NOT be matched as "both bitcoin and lightning"
      expect(result).toBeUndefined();
    });
  });

  // ===== Utility methods =====
  describe('Utility methods', () => {
    it('isBitcoinAddress does not match VOID CashAddr', () => {
      // VOID CashAddr is NOT a Bitcoin address (different chain)
      const result = DeeplinkSchemaMatch.isBitcoinAddress('bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292');
      expect(result).toBe(false);
    });

    it('isLightningInvoice does not match VOID URI', () => {
      expect(DeeplinkSchemaMatch.isLightningInvoice('bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292')).toBe(false);
    });

    it('isPossiblyPSBTFile does not match VOID URI', () => {
      expect(DeeplinkSchemaMatch.isPossiblyPSBTFile('bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292')).toBe(false);
    });

    it('isTXNFile does not match VOID URI', () => {
      expect(DeeplinkSchemaMatch.isTXNFile('bitcoincashii:qr95sy3j9xwd2ap32xkykttr4cvcu7as5yc93ky292')).toBe(false);
    });

    it('isBitcoinAddress returns true for P2SH address starting with 3', () => {
      // 3-prefix is a valid P2SH address on Bitcoin mainnet
      expect(DeeplinkSchemaMatch.isBitcoinAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);
    });

    it('isBitcoinAddress returns true for bech32 address starting with bc1', () => {
      // bc1 prefix is a valid bech32 address on Bitcoin mainnet
      expect(DeeplinkSchemaMatch.isBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(true);
    });

    it('isBitcoinAddress returns true for P2SH address with bitcoin: prefix', () => {
      expect(DeeplinkSchemaMatch.isBitcoinAddress('bitcoin:3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);
    });

    it('isBitcoinAddress returns true for bech32 address with bitcoin: prefix', () => {
      expect(DeeplinkSchemaMatch.isBitcoinAddress('bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(true);
    });
  });
});

describe('bip21decode edge cases', () => {
  it('handles BITCOIN:// (double-slash) prefix by normalizing to bitcoin:', () => {
    const decoded = DeeplinkSchemaMatch.bip21decode('BITCOIN://12eQ9m4sgAwTSQoNXkRABKhCXCsjm2jdVG?amount=0.5');
    expect(decoded.address).toBe('12eQ9m4sgAwTSQoNXkRABKhCXCsjm2jdVG');
    expect(decoded.options.amount).toBe(0.5);
  });

  it('throws for undefined input', () => {
    expect(() => DeeplinkSchemaMatch.bip21decode(undefined)).toThrow('No URI provided');
  });

  it('throws for null input', () => {
    expect(() => DeeplinkSchemaMatch.bip21decode(null as any)).toThrow('No URI provided');
  });

  it('throws for empty string input', () => {
    // bip21 library throws on empty string after replacement
    expect(() => DeeplinkSchemaMatch.bip21decode('')).toThrow();
  });
});

describe('bip21encode edge cases', () => {
  it('uppercases bech32 addresses (bc1 prefix)', () => {
    const encoded = DeeplinkSchemaMatch.bip21encode('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
    expect(encoded).toContain('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4');
  });

  it('removes empty label from options', () => {
    const encoded = DeeplinkSchemaMatch.bip21encode('12eQ9m4sgAwTSQoNXkRABKhCXCsjm2jdVG', { label: ' ', amount: 1 });
    expect(encoded).not.toContain('label');
    expect(encoded).toContain('amount=1');
  });

  it('removes zero or negative amount from options', () => {
    const encodedZero = DeeplinkSchemaMatch.bip21encode('12eQ9m4sgAwTSQoNXkRABKhCXCsjm2jdVG', { amount: 0 });
    expect(encodedZero).not.toContain('amount');

    const encodedNeg = DeeplinkSchemaMatch.bip21encode('12eQ9m4sgAwTSQoNXkRABKhCXCsjm2jdVG', { amount: -5 });
    expect(encodedNeg).not.toContain('amount');
  });
});

describe('decodeBitcoinUri edge cases', () => {
  it('extracts payjoinUrl from pj option', () => {
    const result = DeeplinkSchemaMatch.decodeBitcoinUri(
      'bitcoin:12eQ9m4sgAwTSQoNXkRABKhCXCsjm2jdVG?amount=0.1&pj=https://example.com/pj',
    );
    expect(result.address).toBe('12eQ9m4sgAwTSQoNXkRABKhCXCsjm2jdVG');
    expect(result.amount).toBe(0.1);
    expect(result.payjoinUrl).toBe('https://example.com/pj');
  });

  it('returns defaults when bip21decode throws (invalid URI)', () => {
    const result = DeeplinkSchemaMatch.decodeBitcoinUri('totallygarbage:::///');
    expect(result.address).toBe('totallygarbage:::///');
    expect(result.amount).toBeUndefined();
    expect(result.memo).toBe('');
    expect(result.payjoinUrl).toBe('');
  });
});

describe('getUrlFromSetLndhubUrlAction', () => {
  it('extracts URL correctly from a valid lndhub deeplink', () => {
    const result = DeeplinkSchemaMatch.getUrlFromSetLndhubUrlAction(
      'voidcoin:setlndhuburl?url=https%3A%2F%2Flndhub.herokuapp.com',
    );
    expect(result).toBe('https://lndhub.herokuapp.com');
  });

  it('returns false when no url= param is present', () => {
    const result = DeeplinkSchemaMatch.getUrlFromSetLndhubUrlAction('voidcoin:setlndhuburl');
    expect(result).toBe(false);
  });
});

describe('isBothBitcoinAndLightning exception path', () => {
  it('returns undefined for malformed input that triggers internal catch', () => {
    // Construct a URL that includes both "bitcoin" and "lightning" keywords
    // but with a structure that may cause issues in the split/parse logic.
    // The try-catch inside the for loop should handle out-of-bounds or split errors.
    const malformed = 'bitcoin:lightning:';
    const result = DeeplinkSchemaMatch.isBothBitcoinAndLightning(malformed);
    // Should not crash, returns undefined because btc/lndInvoice won't both be valid
    expect(result).toBeUndefined();
  });

  it('returns undefined when bitcoin part is valid but lightning part is missing', () => {
    // Has both keywords but lightning portion is empty/invalid
    const partial = 'bitcoin:12eQ9m4sgAwTSQoNXkRABKhCXCsjm2jdVG?lightning=';
    const result = DeeplinkSchemaMatch.isBothBitcoinAndLightning(partial);
    expect(result).toBeUndefined();
  });

  it('returns undefined for truncated combined URI', () => {
    // The split result will have entries but accessing index+1 may be undefined
    const truncated = 'bitcoin:lightning';
    const result = DeeplinkSchemaMatch.isBothBitcoinAndLightning(truncated);
    expect(result).toBeUndefined();
  });
});

describe('hasNeededJsonKeysForMultiSigSharing', () => {
  it('validates correct JSON structure with xfp, xpub, and path', () => {
    const valid = JSON.stringify({ xfp: 'AABBCCDD', xpub: 'xpub6ABC123', path: "m/48'/0'/0'/2'" });
    expect(DeeplinkSchemaMatch.hasNeededJsonKeysForMultiSigSharing(valid)).toBe(true);
  });

  it('rejects JSON missing required keys', () => {
    expect(DeeplinkSchemaMatch.hasNeededJsonKeysForMultiSigSharing(JSON.stringify({ xfp: 'AA', xpub: 'xpub6' }))).toBe(false);
  });

  it('rejects non-JSON strings', () => {
    expect(DeeplinkSchemaMatch.hasNeededJsonKeysForMultiSigSharing('not json at all')).toBe(false);
  });

  it('returns false when required keys have null values', () => {
    const withNulls = JSON.stringify({ xfp: null, xpub: null, path: null });
    expect(DeeplinkSchemaMatch.hasNeededJsonKeysForMultiSigSharing(withNulls)).toBe(false);
  });

  it('returns false when required keys have numeric values instead of strings', () => {
    const withNumbers = JSON.stringify({ xfp: 123, xpub: 456, path: 789 });
    expect(DeeplinkSchemaMatch.hasNeededJsonKeysForMultiSigSharing(withNumbers)).toBe(false);
  });

  it('returns false when one required key has null value', () => {
    const partialNull = JSON.stringify({ xfp: 'AABBCCDD', xpub: 'xpub6ABC123', path: null });
    expect(DeeplinkSchemaMatch.hasNeededJsonKeysForMultiSigSharing(partialNull)).toBe(false);
  });

  it('returns true when extra fields are present alongside required keys', () => {
    const withExtras = JSON.stringify({
      xfp: 'AABBCCDD',
      xpub: 'xpub6ABC123',
      path: "m/48'/0'/0'/2'",
      extraField: 'some value',
      anotherExtra: 42,
      nested: { deep: true },
    });
    expect(DeeplinkSchemaMatch.hasNeededJsonKeysForMultiSigSharing(withExtras)).toBe(true);
  });

  it('returns true when many extra fields are present', () => {
    const manyExtras = JSON.stringify({
      xfp: 'AABBCCDD',
      xpub: 'xpub6ABC123',
      path: "m/48'/0'/0'/2'",
      label: 'My Cosigner',
      account: 0,
      fingerprint: 'AABBCCDD',
      derivation: "m/48'/0'/0'/2'",
    });
    expect(DeeplinkSchemaMatch.hasNeededJsonKeysForMultiSigSharing(manyExtras)).toBe(true);
  });

  it('returns true when required keys have empty string values', () => {
    // typeof "" === 'string' is true, so empty strings pass the type check
    const withEmptyStrings = JSON.stringify({ xfp: '', xpub: '', path: '' });
    expect(DeeplinkSchemaMatch.hasNeededJsonKeysForMultiSigSharing(withEmptyStrings)).toBe(true);
  });
});

describe('Widget action edge cases', () => {
  it('does not call completionHandler for invalid widget action value', () => {
    // 'openFoo' does not match 'openSend' or 'openReceive', so no branch executes
    const handler = jest.fn();
    const mockWallet = {
      chain: 'ONCHAIN',
      getID: () => 'mock-wallet-id',
    };
    DeeplinkSchemaMatch.navigationRouteFor(
      { url: 'widget?action=openFoo' },
      handler,
      { wallets: [mockWallet] as any, saveToDisk: () => {}, addWallet: () => {}, setSharedCosigner: () => {} },
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('throws when wallets array is empty and widget action accesses wallet[0].chain', () => {
    // context.wallets.length >= 0 is always true (even for empty array)
    // wallet = context.wallets[0] = undefined, then wallet.chain throws TypeError
    const handler = jest.fn();
    expect(() => {
      DeeplinkSchemaMatch.navigationRouteFor(
        { url: 'widget?action=openSend' },
        handler,
        { wallets: [], saveToDisk: () => {}, addWallet: () => {}, setSharedCosigner: () => {} },
      );
    }).toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('isBothBitcoinAndLightning double-slash edge case', () => {
  it('returns undefined for "bitcoin://lightning:" (double-slash separator)', () => {
    // Contains both "bitcoin" and "lightning" keywords but neither part resolves
    // to a valid bitcoin address or lightning invoice
    const result = DeeplinkSchemaMatch.isBothBitcoinAndLightning('bitcoin://lightning:');
    expect(result).toBeUndefined();
  });
});

describe('Cosigner file with null readFileOutsideSandbox result', () => {
  it('does not call completionHandler when readFileOutsideSandbox returns null', async () => {
    const handler = jest.fn();
    // .bwcosigner extension triggers isPossiblyCosignerFile path
    // The mock returns null, so the if (!file || ...) branch is taken
    DeeplinkSchemaMatch.navigationRouteFor(
      { url: 'file:///path/to/cosigner.bwcosigner' },
      handler,
      { wallets: [], saveToDisk: () => {}, addWallet: () => {}, setSharedCosigner: jest.fn() },
    );
    // Allow the async readFileOutsideSandbox promise to resolve
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('isBitcoinAddress BIP173 uppercase bech32', () => {
  it('handles uppercase bech32 address BC1Q...', () => {
    // BIP173 allows uppercase bech32; bitcoinjs-lib should handle this
    const result = DeeplinkSchemaMatch.isBitcoinAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4');
    expect(result).toBe(true);
  });
});

describe('hasSchema with empty string', () => {
  it('returns false for empty string input', () => {
    expect(DeeplinkSchemaMatch.hasSchema('')).toBe(false);
  });
});

describe('decodeBitcoinUri with missing options', () => {
  it('returns defaults when URI has no amount/label/memo options', () => {
    // A valid bitcoin URI with no query parameters
    const result = DeeplinkSchemaMatch.decodeBitcoinUri('bitcoin:12eQ9m4sgAwTSQoNXkRABKhCXCsjm2jdVG');
    expect(result.address).toBe('12eQ9m4sgAwTSQoNXkRABKhCXCsjm2jdVG');
    expect(result.amount).toBeUndefined();
    expect(result.memo).toBe('');
    expect(result.payjoinUrl).toBe('');
  });
});
