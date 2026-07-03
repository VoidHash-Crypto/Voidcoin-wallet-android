/**
 * VOID Receive Screen
 * Displays QR code and address for receiving VOID
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Share,
  Clipboard,
  Alert,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { VoidColors, VOIDSpacing, VOIDTypography, VOIDShadows, VOIDBorderRadius } from '../../components/VoidTheme';

interface VoidReceiveProps {
  address: string;
  walletLabel?: string;
  isVOID?: boolean;
  navigation?: any;
}

export const VoidReceiveScreen: React.FC<VoidReceiveProps> = ({
  address,
  walletLabel = 'VOID Wallet',
  isVOID = false,
  navigation,
}) => {
  const [copied, setCopied] = useState(false);
  const primaryColor = isVOID ? VoidColors.voidPrimary : VoidColors.primary;
  const coinSymbol = isVOID ? 'VOID' : 'VOID';
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => {
      timersRef.current.forEach(t => clearTimeout(t));
      timersRef.current = [];
    };
  }, []);

  const handleCopyAddress = useCallback(() => {
    Clipboard.setString(address);
    setCopied(true);
    timersRef.current.push(setTimeout(() => setCopied(false), 2000));
    // Clear clipboard after 60 seconds to prevent other apps from reading the address
    timersRef.current.push(setTimeout(() => {
      Clipboard.getString().then((current: string) => {
        if (current === address) {
          Clipboard.setString('');
        }
      }).catch(() => {});
    }, 60000));
  }, [address]);

  const handleShare = useCallback(async () => {
    try {
      await Share.share({
        message: `My ${coinSymbol} address: ${address}`,
        title: `${coinSymbol} Address`,
      });
    } catch (error: any) {
      Alert.alert('Error', 'Failed to share address');
    }
  }, [address, coinSymbol]);

  const formatAddress = (addr: string): string => {
    if (!addr) return '';
    // Split long addresses into two lines for readability
    const midpoint = Math.floor(addr.length / 2);
    return `${addr.slice(0, midpoint)}\n${addr.slice(midpoint)}`;
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Receive {coinSymbol}</Text>
        <Text style={styles.subtitle}>{walletLabel}</Text>
      </View>

      {/* QR Code Card */}
      <View style={[styles.qrCard, { borderColor: primaryColor }]}>
        <View style={styles.qrContainer} accessibilityLabel={`QR code for ${coinSymbol} address`}>
          <QRCode
            value={address}
            size={200}
            color={VoidColors.textPrimary}
            backgroundColor={VoidColors.backgroundCard}
            logo={undefined}
          />
        </View>

        {/* Address Display */}
        <View style={styles.addressContainer}>
          <Text style={[styles.addressLabel, { color: primaryColor }]}>
            {coinSymbol} Address
          </Text>
          <Text style={styles.address} selectable>
            {formatAddress(address)}
          </Text>
        </View>

        {/* Action Buttons */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.actionButton, { borderColor: primaryColor }]}
            onPress={handleCopyAddress}
            accessibilityLabel={copied ? 'Address copied to clipboard' : `Copy ${coinSymbol} address to clipboard`}
            accessibilityRole="button"
          >
            <Text style={[styles.actionButtonText, { color: primaryColor }]}>
              {copied ? '✓ Copied!' : 'Copy Address'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonFilled, { backgroundColor: primaryColor }]}
            onPress={handleShare}
            accessibilityLabel={`Share ${coinSymbol} address`}
            accessibilityRole="button"
          >
            <Text style={styles.actionButtonTextFilled}>
              Share
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Info */}
      <View style={styles.infoCard}>
        <Text style={styles.infoText}>
          Send only {coinSymbol} to this address. Sending other coins may result in permanent loss.
        </Text>
      </View>

      {/* Address Format Info */}
      {!isVOID && (
        <View style={styles.formatInfo}>
          <Text style={styles.formatTitle}>CashAddr Format</Text>
          <Text style={styles.formatText}>
            VOID uses the CashAddr format with the{'\n'}
            <Text style={styles.formatHighlight}>bitcoincashii:</Text> prefix
          </Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: VoidColors.background,
    padding: VOIDSpacing.lg,
  },
  header: {
    alignItems: 'center',
    marginBottom: VOIDSpacing.xl,
    paddingTop: VOIDSpacing.lg,
  },
  title: {
    fontSize: VOIDTypography.fontSize.xxl,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
    marginBottom: VOIDSpacing.xs,
  },
  subtitle: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textSecondary,
  },
  qrCard: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.lg,
    borderWidth: 1,
    padding: VOIDSpacing.xl,
    alignItems: 'center',
    ...VOIDShadows.md,
  },
  qrContainer: {
    padding: VOIDSpacing.md,
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    marginBottom: VOIDSpacing.lg,
  },
  addressContainer: {
    alignItems: 'center',
    marginBottom: VOIDSpacing.lg,
    width: '100%',
  },
  addressLabel: {
    fontSize: VOIDTypography.fontSize.sm,
    fontWeight: VOIDTypography.fontWeight.semibold,
    marginBottom: VOIDSpacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  address: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textPrimary,
    fontFamily: 'monospace',
    textAlign: 'center',
    lineHeight: 22,
  },
  actions: {
    flexDirection: 'row',
    gap: VOIDSpacing.md,
    width: '100%',
  },
  actionButton: {
    flex: 1,
    paddingVertical: VOIDSpacing.md,
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
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.semibold,
    color: VoidColors.textPrimary,
  },
  infoCard: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.md,
    marginTop: VOIDSpacing.lg,
    borderLeftWidth: 3,
    borderLeftColor: VoidColors.warning,
  },
  infoText: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
    lineHeight: 20,
  },
  formatInfo: {
    alignItems: 'center',
    marginTop: VOIDSpacing.xl,
    paddingTop: VOIDSpacing.lg,
    borderTopWidth: 1,
    borderTopColor: VoidColors.border,
  },
  formatTitle: {
    fontSize: VOIDTypography.fontSize.sm,
    fontWeight: VOIDTypography.fontWeight.semibold,
    color: VoidColors.textMuted,
    marginBottom: VOIDSpacing.xs,
  },
  formatText: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
  },
  formatHighlight: {
    color: VoidColors.primary,
    fontFamily: 'monospace',
  },
});

export default VoidReceiveScreen;
