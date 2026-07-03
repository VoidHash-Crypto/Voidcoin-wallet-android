/**
 * VoidCoin Constants
 */

// Block Explorer
export const VOID_EXPLORER_URL = 'https://explorer.void-coin.net';

// Validate that a string looks like a hex txid (64 hex chars)
function isValidTxid(txid: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(txid);
}

// Get transaction URL for explorer
export function getVoidTransactionUrl(txid: string): string {
  if (!isValidTxid(txid)) return VOID_EXPLORER_URL;
  return `${VOID_EXPLORER_URL}/tx/${txid}`;
}

// Get address URL for explorer
export function getVoidAddressUrl(address: string): string {
  return `${VOID_EXPLORER_URL}/address/${encodeURIComponent(address)}`;
}

// Get block URL for explorer (by hash)
export function getVoidBlockUrl(blockHash: string): string {
  if (!isValidTxid(blockHash)) return VOID_EXPLORER_URL;
  return `${VOID_EXPLORER_URL}/block/${blockHash}`;
}

// Get block URL for explorer (by height)
export function getVoidBlockHeightUrl(height: number): string {
  if (!Number.isInteger(height) || height < 0) return VOID_EXPLORER_URL;
  return `${VOID_EXPLORER_URL}/block-height/${height}`;
}

// Network constants
export const VOID_NETWORK = {
  ticker: 'VOID',
  name: 'VoidCoin',
  p2p_port: 7777,
  rpc_port: 7778,
  bech32_hrp: 'void',
  bech32_qr_hrp: 'vqr',
  electrum_host: '46.7.7.113',
  electrum_port: 50001,
  explorer_url: VOID_EXPLORER_URL,
};

export default {
  VOID_EXPLORER_URL,
  VOID_NETWORK,
  getVoidTransactionUrl,
  getVoidAddressUrl,
  getVoidBlockUrl,
  getVoidBlockHeightUrl,
};
