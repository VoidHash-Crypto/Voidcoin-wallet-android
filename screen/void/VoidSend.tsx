/**
 * VOID Send Screen
 * Send VOID or VOID to another address
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Keyboard,
} from 'react-native';
import { VoidColors, VOIDSpacing, VOIDTypography, VOIDShadows, VOIDBorderRadius } from '../../components/VoidTheme';
import { decodeCashAddr } from '../../class/void-transaction';
const bs58check = require('bs58check');

interface VoidSendProps {
  walletBalance: number;
  walletAddress: string;
  isVOID?: boolean;
  onSend?: (toAddress: string, amount: number, fee: number) => Promise<{ txid: string }>;
  navigation?: any;
}

export const VoidSendScreen: React.FC<VoidSendProps> = ({
  walletBalance,
  walletAddress,
  isVOID = false,
  onSend,
  navigation,
}) => {
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('1'); // sat/byte
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'input' | 'confirm' | 'success'>('input');
  const [txid, setTxid] = useState('');
  const sendingRef = useRef(false);

  const primaryColor = isVOID ? VoidColors.voidPrimary : VoidColors.primary;
  const coinSymbol = isVOID ? 'VOID' : 'VOID';
  const addressPrefix = isVOID ? '' : 'bitcoincashii:';

  const formatBalance = (sats: number): string => {
    return (sats / 100000000).toFixed(8);
  };

  const parseAmount = (amountStr: string): number => {
    // Normalize comma decimal separator for European locales
    const normalized = amountStr.replace(',', '.');
    // Reject scientific notation and non-numeric input
    if (!/^\d*\.?\d*$/.test(normalized) || normalized === '' || normalized === '.') return 0;
    const parsed = parseFloat(normalized);
    if (isNaN(parsed) || !isFinite(parsed)) return 0;
    const sats = Math.round(parsed * 100000000);
    if (!Number.isSafeInteger(sats) || sats < 0) return 0;
    return sats;
  };

  const amountInSats = parseAmount(amount);
  // Estimate tx size: ~148 bytes/input + ~34 bytes/output + ~10 overhead
  // Assume 1 input for display; actual fee computed during signing
  const feePerByte = Math.min(1000, Math.max(1, parseInt(fee) || 1));
  const estimatedSize = 1 * 148 + 2 * 34 + 10; // 226 for single-input
  const feeInSats = feePerByte * estimatedSize;
  const totalInSats = amountInSats + feeInSats;

  const validateAddress = (addr: string): boolean => {
    if (!addr) return false;
    if (isVOID) {
      // Validate with full Base58Check checksum verification
      try {
        const decoded = bs58check.decode(addr);
        if (decoded.length !== 21) return false;
        // Version byte: 0x00 = P2PKH (starts with 1), 0x05 = P2SH (starts with 3)
        return decoded[0] === 0x00 || decoded[0] === 0x05;
      } catch {
        return false;
      }
    } else {
      // VOID CashAddr format with full polymod checksum verification
      const normalizedAddr = addr.toLowerCase();
      // Reject BCH addresses (wrong chain)
      if (normalizedAddr.startsWith('bitcoincash:') || normalizedAddr.startsWith('bchtest:')) {
        return false;
      }
      // Require bitcoincashii: prefix for VOID addresses
      if (!normalizedAddr.startsWith('bitcoincashii:')) {
        return false;
      }
      // Validate CashAddr checksum using decodeCashAddr
      try {
        decodeCashAddr(addr);
        return true;
      } catch {
        return false;
      }
    }
  };

  const handleMaxAmount = useCallback(() => {
    const maxSats = walletBalance - feeInSats;
    if (maxSats > 0) {
      setAmount(formatBalance(maxSats));
    }
  }, [walletBalance, feeInSats]);

  const handleContinue = useCallback(() => {
    Keyboard.dismiss();

    if (!validateAddress(toAddress)) {
      Alert.alert('Invalid Address', `Please enter a valid ${coinSymbol} address`);
      return;
    }

    if (amountInSats <= 0) {
      Alert.alert('Invalid Amount', 'Please enter an amount greater than 0');
      return;
    }

    if (totalInSats > walletBalance) {
      Alert.alert('Insufficient Balance', 'You do not have enough balance for this transaction');
      return;
    }

    if (amountInSats < 546) {
      Alert.alert('Dust Amount', 'Amount is too small. Minimum is 546 satoshis');
      return;
    }

    setStep('confirm');
  }, [toAddress, amountInSats, totalInSats, walletBalance, coinSymbol]);

  const handleSend = useCallback(async () => {
    if (!onSend) {
      Alert.alert('Error', 'Send function not configured');
      return;
    }
    if (sendingRef.current) return; // Prevent double-tap
    sendingRef.current = true;

    setLoading(true);
    try {
      const clampedFee = Math.min(1000, Math.max(1, parseInt(fee) || 1));
      const result = await onSend(toAddress, amountInSats, clampedFee);
      setTxid(result.txid);
      setStep('success');
    } catch (error: any) {
      if (!error?.__cancelled) {
        const msg = error?.message || '';
        const safeMsg = msg.includes('dust') ? 'Transaction amount is too small'
          : msg.includes('insufficient') ? 'Insufficient funds for this transaction'
          : msg.includes('mempool') ? 'Transaction rejected by network. Please try again.'
          : 'Failed to broadcast transaction. Please check your connection and try again.';
        Alert.alert('Transaction Failed', safeMsg);
      }
    } finally {
      setLoading(false);
      sendingRef.current = false;
    }
  }, [onSend, toAddress, amountInSats, fee]);

  const handleDone = useCallback(() => {
    navigation?.goBack();
  }, [navigation]);

  const formatAddress = (addr: string): string => {
    if (!addr) return '';
    if (addr.length <= 20) return addr;
    return `${addr.slice(0, 12)}...${addr.slice(-8)}`;
  };

  // Input Step
  if (step === 'input') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Send {coinSymbol}</Text>
          <View style={styles.balanceRow}>
            <Text style={styles.balanceLabel}>Available:</Text>
            <Text style={[styles.balanceValue, { color: primaryColor }]}>
              {formatBalance(walletBalance)} {coinSymbol}
            </Text>
          </View>
        </View>

        {/* To Address */}
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>To Address</Text>
          <TextInput
            style={styles.input}
            value={toAddress}
            onChangeText={setToAddress}
            placeholder={`${addressPrefix}q...`}
            placeholderTextColor={VoidColors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={120}
            accessibilityLabel={`Recipient ${coinSymbol} address`}
          />
        </View>

        {/* Amount */}
        <View style={styles.inputGroup}>
          <View style={styles.inputLabelRow}>
            <Text style={styles.inputLabel}>Amount ({coinSymbol})</Text>
            <TouchableOpacity onPress={handleMaxAmount} accessibilityLabel="Set maximum amount" accessibilityRole="button">
              <Text style={[styles.maxButton, { color: primaryColor }]}>MAX</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.input}
            value={amount}
            onChangeText={setAmount}
            placeholder="0.00000000"
            placeholderTextColor={VoidColors.textMuted}
            keyboardType="decimal-pad"
            maxLength={18}
            accessibilityLabel={`Amount in ${coinSymbol}`}
          />
        </View>

        {/* Fee */}
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Fee (sat/byte)</Text>
          <View style={styles.feeSelector}>
            {['1', '2', '5'].map((feeOption) => (
              <TouchableOpacity
                key={feeOption}
                style={[
                  styles.feeButton,
                  fee === feeOption && { backgroundColor: primaryColor, borderColor: primaryColor },
                ]}
                onPress={() => setFee(feeOption)}
                accessibilityLabel={`Fee: ${feeOption} satoshi per byte${fee === feeOption ? ', selected' : ''}`}
                accessibilityRole="button"
              >
                <Text style={[
                  styles.feeButtonText,
                  fee === feeOption && styles.feeButtonTextActive,
                ]}>
                  {feeOption}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.feeEstimate}>
            Estimated fee: ~{feeInSats} sats ({formatBalance(feeInSats)} {coinSymbol})
          </Text>
        </View>

        {/* Summary */}
        {amountInSats > 0 && (
          <View style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Amount</Text>
              <Text style={styles.summaryValue}>{formatBalance(amountInSats)} {coinSymbol}</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Fee</Text>
              <Text style={styles.summaryValue}>{formatBalance(feeInSats)} {coinSymbol}</Text>
            </View>
            <View style={[styles.summaryRow, styles.summaryTotal]}>
              <Text style={styles.summaryTotalLabel}>Total</Text>
              <Text style={[styles.summaryTotalValue, { color: primaryColor }]}>
                {formatBalance(totalInSats)} {coinSymbol}
              </Text>
            </View>
          </View>
        )}

        {/* Continue Button */}
        <TouchableOpacity
          style={[styles.sendButton, { backgroundColor: primaryColor }]}
          onPress={handleContinue}
          accessibilityLabel="Continue to confirm transaction"
          accessibilityRole="button"
        >
          <Text style={styles.sendButtonText}>Continue</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // Confirm Step
  if (step === 'confirm') {
    return (
      <View style={styles.container}>
        <View style={styles.confirmContent}>
          <Text style={styles.confirmTitle}>Confirm Transaction</Text>

          <View style={styles.confirmCard}>
            <View style={styles.confirmRow}>
              <Text style={styles.confirmLabel}>To</Text>
              <Text style={[styles.confirmValue, { fontSize: 12 }]} selectable numberOfLines={3}>{toAddress}</Text>
            </View>
            <View style={styles.confirmRow}>
              <Text style={styles.confirmLabel}>Amount</Text>
              <Text style={[styles.confirmValueLarge, { color: primaryColor }]}>
                {formatBalance(amountInSats)} {coinSymbol}
              </Text>
            </View>
            <View style={styles.confirmRow}>
              <Text style={styles.confirmLabel}>Fee</Text>
              <Text style={styles.confirmValue}>{formatBalance(feeInSats)} {coinSymbol}</Text>
            </View>
            <View style={[styles.confirmRow, styles.confirmTotal]}>
              <Text style={styles.confirmTotalLabel}>Total</Text>
              <Text style={styles.confirmTotalValue}>
                {formatBalance(totalInSats)} {coinSymbol}
              </Text>
            </View>
          </View>

          <View style={styles.confirmActions}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setStep('input')}
              disabled={loading}
              accessibilityLabel="Go back to edit transaction"
              accessibilityRole="button"
            >
              <Text style={styles.cancelButtonText}>Back</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.confirmButton, { backgroundColor: primaryColor }]}
              onPress={handleSend}
              disabled={loading}
              accessibilityLabel={`Send ${formatBalance(amountInSats)} ${coinSymbol}`}
              accessibilityRole="button"
            >
              {loading ? (
                <ActivityIndicator color={VoidColors.textPrimary} />
              ) : (
                <Text style={styles.confirmButtonText}>Send {coinSymbol}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  // Success Step
  return (
    <View style={styles.container}>
      <View style={styles.successContent}>
        <View style={[styles.successIcon, { borderColor: primaryColor }]}>
          <Text style={styles.successIconText}>✓</Text>
        </View>

        <Text style={styles.successTitle}>Transaction Sent!</Text>
        <Text style={styles.successAmount}>
          {formatBalance(amountInSats)} {coinSymbol}
        </Text>

        <View style={styles.txidCard}>
          <Text style={styles.txidLabel}>Transaction ID</Text>
          <Text style={styles.txidValue} selectable>
            {txid}
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.doneButton, { backgroundColor: primaryColor }]}
          onPress={handleDone}
          accessibilityLabel="Done, return to wallet"
          accessibilityRole="button"
        >
          <Text style={styles.doneButtonText}>Done</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: VoidColors.background,
  },
  content: {
    padding: VOIDSpacing.lg,
  },
  header: {
    marginBottom: VOIDSpacing.xl,
  },
  title: {
    fontSize: VOIDTypography.fontSize.xxl,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
    marginBottom: VOIDSpacing.sm,
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  balanceLabel: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textSecondary,
    marginRight: VOIDSpacing.sm,
  },
  balanceValue: {
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.semibold,
    fontFamily: 'monospace',
  },
  inputGroup: {
    marginBottom: VOIDSpacing.lg,
  },
  inputLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: VOIDSpacing.sm,
  },
  inputLabel: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
    marginBottom: VOIDSpacing.sm,
  },
  maxButton: {
    fontSize: VOIDTypography.fontSize.sm,
    fontWeight: VOIDTypography.fontWeight.bold,
  },
  input: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    borderWidth: 1,
    borderColor: VoidColors.border,
    padding: VOIDSpacing.md,
    color: VoidColors.textPrimary,
    fontSize: VOIDTypography.fontSize.base,
    fontFamily: 'monospace',
  },
  feeSelector: {
    flexDirection: 'row',
    gap: VOIDSpacing.sm,
    marginBottom: VOIDSpacing.sm,
  },
  feeButton: {
    flex: 1,
    paddingVertical: VOIDSpacing.sm,
    alignItems: 'center',
    borderRadius: VOIDBorderRadius.md,
    borderWidth: 1,
    borderColor: VoidColors.border,
    backgroundColor: VoidColors.backgroundCard,
  },
  feeButtonText: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textSecondary,
    fontWeight: VOIDTypography.fontWeight.medium,
  },
  feeButtonTextActive: {
    color: VoidColors.textPrimary,
  },
  feeEstimate: {
    fontSize: VOIDTypography.fontSize.xs,
    color: VoidColors.textMuted,
  },
  summaryCard: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.md,
    marginBottom: VOIDSpacing.xl,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: VOIDSpacing.xs,
  },
  summaryLabel: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
  },
  summaryValue: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
    fontFamily: 'monospace',
  },
  summaryTotal: {
    borderTopWidth: 1,
    borderTopColor: VoidColors.border,
    marginTop: VOIDSpacing.sm,
    paddingTop: VOIDSpacing.sm,
  },
  summaryTotalLabel: {
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.semibold,
    color: VoidColors.textPrimary,
  },
  summaryTotalValue: {
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.bold,
    fontFamily: 'monospace',
  },
  sendButton: {
    borderRadius: VOIDBorderRadius.md,
    paddingVertical: VOIDSpacing.md,
    alignItems: 'center',
    ...VOIDShadows.glow,
  },
  sendButtonText: {
    color: VoidColors.textPrimary,
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
  },
  // Confirm styles
  confirmContent: {
    flex: 1,
    padding: VOIDSpacing.lg,
    justifyContent: 'center',
  },
  confirmTitle: {
    fontSize: VOIDTypography.fontSize.xl,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
    textAlign: 'center',
    marginBottom: VOIDSpacing.xl,
  },
  confirmCard: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.lg,
    padding: VOIDSpacing.lg,
    marginBottom: VOIDSpacing.xl,
  },
  confirmRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: VOIDSpacing.sm,
  },
  confirmLabel: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textMuted,
  },
  confirmValue: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textSecondary,
    fontFamily: 'monospace',
  },
  confirmValueLarge: {
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
    fontFamily: 'monospace',
  },
  confirmTotal: {
    borderTopWidth: 1,
    borderTopColor: VoidColors.border,
    marginTop: VOIDSpacing.sm,
    paddingTop: VOIDSpacing.md,
  },
  confirmTotalLabel: {
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
  },
  confirmTotalValue: {
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
    fontFamily: 'monospace',
  },
  confirmActions: {
    flexDirection: 'row',
    gap: VOIDSpacing.md,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: VOIDSpacing.md,
    alignItems: 'center',
    borderRadius: VOIDBorderRadius.md,
    borderWidth: 1,
    borderColor: VoidColors.border,
  },
  cancelButtonText: {
    color: VoidColors.textSecondary,
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.semibold,
  },
  confirmButton: {
    flex: 2,
    paddingVertical: VOIDSpacing.md,
    alignItems: 'center',
    borderRadius: VOIDBorderRadius.md,
    ...VOIDShadows.glow,
  },
  confirmButtonText: {
    color: VoidColors.textPrimary,
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
  },
  // Success styles
  successContent: {
    flex: 1,
    padding: VOIDSpacing.lg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  successIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: VOIDSpacing.xl,
  },
  successIconText: {
    fontSize: 40,
    color: VoidColors.success,
  },
  successTitle: {
    fontSize: VOIDTypography.fontSize.xl,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
    marginBottom: VOIDSpacing.sm,
  },
  successAmount: {
    fontSize: VOIDTypography.fontSize.xxl,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.success,
    fontFamily: 'monospace',
    marginBottom: VOIDSpacing.xl,
  },
  txidCard: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.md,
    width: '100%',
    marginBottom: VOIDSpacing.xl,
  },
  txidLabel: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
    marginBottom: VOIDSpacing.xs,
  },
  txidValue: {
    fontSize: VOIDTypography.fontSize.xs,
    color: VoidColors.textSecondary,
    fontFamily: 'monospace',
  },
  doneButton: {
    paddingVertical: VOIDSpacing.md,
    paddingHorizontal: VOIDSpacing.xxl,
    borderRadius: VOIDBorderRadius.md,
    ...VOIDShadows.glow,
  },
  doneButtonText: {
    color: VoidColors.textPrimary,
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
  },
});

export default VoidSendScreen;
