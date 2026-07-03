/**
 * VOID Wallet Card Component
 * Displays wallet balance with VOID branding
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Image } from 'react-native';
import { VoidColors, VOIDSpacing, VOIDTypography, VOIDShadows, VOIDBorderRadius } from './VoidTheme';

// Coin logos
const VOID_LOGO = require('../img/void-logo-small.png');
const VOID_LOGO = require('../img/void-logo-small.png');

interface VoidWalletCardProps {
  balance: number;
  unconfirmedBalance?: number;
  address?: string;
  walletLabel?: string; // Custom wallet name
  onPress?: () => void;
  onReceive?: () => void;
  onSend?: () => void;
  isVOID?: boolean; // Show as VOID wallet (orange theme)
}

export const VoidWalletCard: React.FC<VoidWalletCardProps> = ({
  balance,
  unconfirmedBalance = 0,
  address,
  walletLabel,
  onPress,
  onReceive,
  onSend,
  isVOID = false,
}) => {
  const primaryColor = isVOID ? VoidColors.voidPrimary : VoidColors.primary;
  const badgeColor = isVOID ? VoidColors.voidLight : VoidColors.primary;
  const coinSymbol = isVOID ? 'VOID' : 'VOID';

  const formatBalance = (sats: number): string => {
    return (sats / 100000000).toFixed(8);
  };

  const formatAddress = (addr: string): string => {
    if (!addr) return '';
    if (addr.length <= 20) return addr;
    return `${addr.slice(0, 14)}...${addr.slice(-8)}`;
  };

  return (
    <TouchableOpacity
      style={[styles.container, { borderColor: primaryColor }]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      {/* Header */}
      <View style={styles.header}>
        <Image
          source={isVOID ? VOID_LOGO : VOID_LOGO}
          style={styles.coinLogo}
          resizeMode="contain"
        />
        <View style={styles.headerText}>
          <Text style={styles.label}>
            {walletLabel || (isVOID ? 'BitcoinII' : 'VoidCoin')}
          </Text>
          <View style={[styles.coinBadge, { backgroundColor: badgeColor }]}>
            <Text style={styles.coinBadgeText}>{coinSymbol}</Text>
          </View>
        </View>
      </View>

      {/* Balance */}
      <View style={styles.balanceContainer}>
        <Text style={[styles.balance, { color: primaryColor }]}>
          {formatBalance(balance)}
        </Text>
        <Text style={styles.balanceSymbol}>{coinSymbol}</Text>
      </View>

      {/* Unconfirmed */}
      {unconfirmedBalance !== 0 && (
        <Text style={styles.unconfirmed}>
          {unconfirmedBalance > 0 ? '+' : ''}{formatBalance(unconfirmedBalance)} pending
        </Text>
      )}

      {/* Address */}
      {address && (
        <Text style={styles.address}>
          {formatAddress(address)}
        </Text>
      )}

      {/* Action Buttons */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.actionButton, { borderColor: primaryColor }]}
          onPress={onReceive}
        >
          <Text style={[styles.actionButtonText, { color: primaryColor }]}>
            Receive
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionButton, styles.actionButtonFilled, { backgroundColor: primaryColor }]}
          onPress={onSend}
        >
          <Text style={[styles.actionButtonText, styles.actionButtonTextFilled]}>
            Send
          </Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.lg,
    borderWidth: 1,
    padding: VOIDSpacing.lg,
    marginHorizontal: VOIDSpacing.md,
    marginVertical: VOIDSpacing.sm,
    ...VOIDShadows.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: VOIDSpacing.md,
  },
  coinLogo: {
    width: 48,
    height: 48,
    marginRight: VOIDSpacing.md,
  },
  headerText: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  coinBadge: {
    paddingHorizontal: VOIDSpacing.sm,
    paddingVertical: VOIDSpacing.xs,
    borderRadius: VOIDBorderRadius.sm,
  },
  coinBadgeText: {
    color: VoidColors.textPrimary,
    fontSize: VOIDTypography.fontSize.sm,
    fontWeight: VOIDTypography.fontWeight.bold,
  },
  label: {
    color: VoidColors.textSecondary,
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.medium,
  },
  balanceContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: VOIDSpacing.xs,
  },
  balance: {
    fontSize: VOIDTypography.fontSize.xxl,
    fontWeight: VOIDTypography.fontWeight.bold,
    fontFamily: 'monospace',
  },
  balanceSymbol: {
    color: VoidColors.textSecondary,
    fontSize: VOIDTypography.fontSize.lg,
    marginLeft: VOIDSpacing.sm,
  },
  unconfirmed: {
    color: VoidColors.warning,
    fontSize: VOIDTypography.fontSize.sm,
    marginBottom: VOIDSpacing.sm,
  },
  address: {
    color: VoidColors.textMuted,
    fontSize: VOIDTypography.fontSize.xs,
    fontFamily: 'monospace',
    marginBottom: VOIDSpacing.md,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: VOIDSpacing.md,
  },
  actionButton: {
    flex: 1,
    paddingVertical: VOIDSpacing.sm,
    paddingHorizontal: VOIDSpacing.md,
    borderRadius: VOIDBorderRadius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  actionButtonFilled: {
    borderWidth: 0,
  },
  actionButtonText: {
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.semibold,
  },
  actionButtonTextFilled: {
    color: VoidColors.textPrimary,
  },
});

export default VoidWalletCard;
