/**
 * VOID Units and Chain Types
 */

export const VOIDUnit = {
  VOID: 'VOID',
  SATS: 'sats',
  LOCAL_CURRENCY: 'local_currency',
  MAX: 'MAX',
} as const;

export type VOIDUnit = (typeof VOIDUnit)[keyof typeof VOIDUnit];

export const CoinType = {
  VOID: 'VOID',
  VOID: 'VOID',
} as const;

export type CoinType = (typeof CoinType)[keyof typeof CoinType];

/**
 * Format VOID amount for display
 */
export function formatVOIDAmount(satoshis: number, unit: VOIDUnit = VOIDUnit.VOID): string {
  switch (unit) {
    case VOIDUnit.VOID:
      return (satoshis / 100000000).toFixed(8) + ' VOID';
    case VOIDUnit.SATS:
      return satoshis.toString() + ' sats';
    default:
      return (satoshis / 100000000).toFixed(8) + ' VOID';
  }
}

/**
 * Parse VOID amount string to satoshis.
 * Caller must specify the unit to avoid ambiguity.
 * Defaults to VOID (i.e. "1.5" = 150_000_000 sats).
 */
export function parseVOIDAmount(amount: string, unit: VOIDUnit = VOIDUnit.VOID): number {
  const cleaned = amount.replace(/[^0-9.]/g, '');
  const value = parseFloat(cleaned);
  if (isNaN(value) || !isFinite(value)) return 0;

  if (unit === VOIDUnit.SATS) {
    const sats = Math.floor(value);
    if (!Number.isSafeInteger(sats) || sats < 0) return 0;
    return sats;
  }

  // VOID unit: convert to satoshis
  const sats = Math.round(value * 100000000);
  if (!Number.isSafeInteger(sats) || sats < 0) return 0;
  return sats;
}

/**
 * VOID fork information
 */
export const VOID_FORK_INFO = {
  forkHeight: 53200,
  forkTimestamp: 0, // Will be set when fork happens
  coinName: 'VoidCoin',
  symbol: 'VOID',
  addressPrefix: 'bitcoincashii',
  defaultPort: 8339,
  rpcPort: 8342,
  electrumPort: 50001,
  electrumSSLPort: 50002,
} as const;

export default {
  VOIDUnit,
  CoinType,
  formatVOIDAmount,
  parseVOIDAmount,
  VOID_FORK_INFO,
};
