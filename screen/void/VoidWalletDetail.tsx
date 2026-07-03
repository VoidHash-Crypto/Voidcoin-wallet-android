/**
 * VOID Wallet Detail Screen
 * Shows wallet details, transactions, and actions
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Alert,
  Linking,
} from 'react-native';
import { VoidColors, VOIDSpacing, VOIDTypography, VOIDShadows, VOIDBorderRadius } from '../../components/VoidTheme';
import { getWalletMnemonic } from '../../class/void-wallet-storage';
import { useScreenProtect } from '../../hooks/useScreenProtect';
import { getVoidTransactionUrl, getVoidTransactionUrl, getVoidBlockUrl, getVoidBlockUrl } from '../../class/void-constants';

interface Transaction {
  txid: string;
  confirmations: number;
  amount: number; // In satoshis, positive = received, negative = sent
  timestamp: number;
  fee?: number;
  height?: number;
}

interface VoidWalletDetailProps {
  walletId: string;
  label?: string;
  balance: number;
  unconfirmedBalance: number;
  address: string;
  isVOID?: boolean;
  transactions?: Transaction[];
  navigation?: any;
  onRefresh?: () => Promise<void>;
  refreshing?: boolean;
}

export const VoidWalletDetailScreen: React.FC<VoidWalletDetailProps> = ({
  walletId,
  label = 'VOID Wallet',
  balance,
  unconfirmedBalance,
  address,
  isVOID = false,
  transactions = [],
  navigation,
  onRefresh: externalRefresh,
  refreshing: externalRefreshing,
}) => {
  const [internalRefreshing, setInternalRefreshing] = useState(false);
  const refreshing = externalRefreshing ?? internalRefreshing;
  const primaryColor = isVOID ? VoidColors.voidPrimary : VoidColors.primary;
  const coinSymbol = isVOID ? 'VOID' : 'VOID';

  const onRefresh = useCallback(async () => {
    if (externalRefresh) {
      await externalRefresh();
    } else {
      setInternalRefreshing(true);
      await new Promise(resolve => setTimeout(resolve, 1000));
      setInternalRefreshing(false);
    }
  }, [externalRefresh]);

  const openTransactionInExplorer = (txid: string) => {
    const url = isVOID ? getVoidTransactionUrl(txid) : getVoidTransactionUrl(txid);
    Linking.openURL(url).catch(() => { /* silently ignore link-open failures */ });
  };

  const formatBalance = (sats: number): string => {
    return (sats / 100000000).toFixed(8);
  };

  const formatAddress = (addr: string): string => {
    if (!addr) return '';
    if (addr.length <= 24) return addr;
    return `${addr.slice(0, 14)}...${addr.slice(-10)}`;
  };

  const formatDate = (timestamp: number): string => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const navigateToReceive = () => {
    navigation?.navigate('VoidReceive', {
      address,
      walletLabel: label,
      isVOID,
      walletId,
    });
  };

  const navigateToSend = () => {
    navigation?.navigate('VoidSend', {
      walletId: walletId,
      walletBalance: balance,
      walletAddress: address,
      isVOID: isVOID,
    });
  };

  const { enableScreenProtect, disableScreenProtect } = useScreenProtect();

  const showMnemonicAlert = (mnemonic: string) => {
    enableScreenProtect();
    Alert.alert(
      '⚠️ Backup Recovery Phrase',
      `WRITE THIS DOWN AND KEEP IT SAFE!\n\nYour recovery phrase:\n\n${mnemonic}\n\nAnyone with this phrase can access your funds. Never share it.`,
      [
        { text: 'I\'ve Saved It', style: 'default', onPress: () => disableScreenProtect() },
      ],
      { onDismiss: () => disableScreenProtect() }
    );
  };

  const handleBackupWallet = async () => {
    try {
      const mnemonic = await getWalletMnemonic(walletId);
      if (mnemonic) {
        showMnemonicAlert(mnemonic);
      } else {
        Alert.alert('Error', 'Could not retrieve wallet backup phrase.');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to export wallet backup.');
    }
  };

  const formatTxid = (txid: string): string => {
    if (!txid || txid.length <= 16) return txid;
    return `${txid.slice(0, 8)}...${txid.slice(-8)}`;
  };

  const renderTransaction = ({ item }: { item: Transaction }) => {
    const isReceived = item.amount >= 0;
    const absAmount = Math.abs(item.amount);
    const hasHeight = item.height && item.height > 0;

    return (
      <TouchableOpacity style={styles.txItem} onPress={() => openTransactionInExplorer(item.txid)} accessibilityLabel={`Transaction ${formatTxid(item.txid)}, ${isReceived ? 'received' : 'sent'} ${formatBalance(absAmount)} ${coinSymbol}, ${hasHeight ? `confirmed at block ${item.height}` : 'pending'}. Tap to view in explorer.`} accessibilityRole="button">
        <View style={styles.txLeft}>
          <View style={[styles.txIcon, { backgroundColor: hasHeight ? VoidColors.success : VoidColors.warning }]}>
            <Text style={styles.txIconText}>{hasHeight ? '✓' : '⏳'}</Text>
          </View>
          <View style={styles.txInfo}>
            <Text style={styles.txId}>{formatTxid(item.txid)}</Text>
            <Text style={styles.txDate}>
              {hasHeight ? `Block ${item.height}` : 'Pending'}
            </Text>
          </View>
        </View>
        <View style={styles.txRight}>
          {absAmount > 0 ? (
            <Text style={[styles.txAmount, { color: isReceived ? VoidColors.success : VoidColors.error }]}>
              {isReceived ? '+' : '-'}{formatBalance(absAmount)}
            </Text>
          ) : (
            <Text style={styles.txViewLink}>View →</Text>
          )}
          <Text style={styles.txConfirmations}>
            Tap to view in explorer
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <>
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={primaryColor}
        />
      }
    >
      {/* Balance Card */}
      <View style={[styles.balanceCard, { borderColor: primaryColor }]}>
        <View style={[styles.coinBadge, { backgroundColor: primaryColor }]}>
          <Text style={styles.coinBadgeText}>{coinSymbol}</Text>
        </View>

        <Text style={styles.walletLabel}>{label}</Text>

        <View style={styles.balanceContainer}>
          <Text style={[styles.balance, { color: primaryColor }]}>
            {formatBalance(balance)}
          </Text>
          <Text style={styles.balanceSymbol}>{coinSymbol}</Text>
        </View>

        {unconfirmedBalance !== 0 && (
          <Text style={styles.unconfirmed}>
            {unconfirmedBalance > 0 ? '+' : ''}{formatBalance(unconfirmedBalance)} pending
          </Text>
        )}

        <TouchableOpacity style={styles.addressContainer}>
          <Text style={styles.address}>{formatAddress(address)}</Text>
        </TouchableOpacity>

        {/* Action Buttons */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.actionButton, { borderColor: primaryColor }]}
            onPress={navigateToReceive}
            accessibilityLabel={`Receive ${coinSymbol}`}
            accessibilityRole="button"
          >
            <Text style={[styles.actionIcon, { color: primaryColor }]}>↓</Text>
            <Text style={[styles.actionText, { color: primaryColor }]}>Receive</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonFilled, { backgroundColor: primaryColor }]}
            onPress={navigateToSend}
            accessibilityLabel={`Send ${coinSymbol}`}
            accessibilityRole="button"
          >
            <Text style={styles.actionIconFilled}>↑</Text>
            <Text style={styles.actionTextFilled}>Send</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Transactions */}
      <View style={styles.transactionsSection}>
        <Text style={styles.sectionTitle}>Transactions</Text>

        {transactions.length === 0 ? (
          <View style={styles.emptyTx}>
            <Text style={styles.emptyTxIcon}>📜</Text>
            <Text style={styles.emptyTxText}>No transactions yet</Text>
            <Text style={styles.emptyTxSubtext}>
              Receive some {coinSymbol} to get started
            </Text>
          </View>
        ) : (
          <View style={styles.txList}>
            {transactions.map((tx, index) => (
              <View key={tx.txid || index}>
                {renderTransaction({ item: tx })}
              </View>
            ))}
          </View>
        )}
      </View>

      {/* Wallet Info */}
      <View style={styles.infoSection}>
        <Text style={styles.sectionTitle}>Wallet Info</Text>

        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Type</Text>
            <Text style={styles.infoValue}>
              {isVOID ? 'VOID Legacy (P2PKH)' : 'VOID (CashAddr)'}
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Full Address</Text>
            <Text style={[styles.infoValue, styles.infoValueMono]} numberOfLines={2}>
              {address}
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Derivation Path</Text>
            <Text style={[styles.infoValue, styles.infoValueMono]}>
              {isVOID ? "m/44'/0'/0'" : "m/44'/145'/0'"}
            </Text>
          </View>
        </View>
      </View>

      {/* Export/Backup Button */}
      <TouchableOpacity style={styles.exportButton} onPress={handleBackupWallet} accessibilityLabel="Export wallet backup recovery phrase" accessibilityRole="button">
        <Text style={styles.exportButtonText}>Export Wallet Backup</Text>
      </TouchableOpacity>
    </ScrollView>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: VoidColors.background,
  },
  content: {
    padding: VOIDSpacing.lg,
    paddingBottom: VOIDSpacing.xxl,
  },
  balanceCard: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.lg,
    borderWidth: 1,
    padding: VOIDSpacing.xl,
    alignItems: 'center',
    marginBottom: VOIDSpacing.xl,
    ...VOIDShadows.md,
  },
  coinBadge: {
    paddingHorizontal: VOIDSpacing.md,
    paddingVertical: VOIDSpacing.xs,
    borderRadius: VOIDBorderRadius.sm,
    marginBottom: VOIDSpacing.sm,
  },
  coinBadgeText: {
    color: VoidColors.textPrimary,
    fontSize: VOIDTypography.fontSize.sm,
    fontWeight: VOIDTypography.fontWeight.bold,
  },
  walletLabel: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textSecondary,
    marginBottom: VOIDSpacing.md,
  },
  balanceContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: VOIDSpacing.xs,
  },
  balance: {
    fontSize: VOIDTypography.fontSize.xxxl,
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
    marginBottom: VOIDSpacing.md,
  },
  addressContainer: {
    backgroundColor: VoidColors.backgroundElevated,
    borderRadius: VOIDBorderRadius.sm,
    paddingVertical: VOIDSpacing.xs,
    paddingHorizontal: VOIDSpacing.md,
    marginBottom: VOIDSpacing.lg,
  },
  address: {
    color: VoidColors.textMuted,
    fontSize: VOIDTypography.fontSize.sm,
    fontFamily: 'monospace',
  },
  actions: {
    flexDirection: 'row',
    gap: VOIDSpacing.md,
    width: '100%',
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: VOIDSpacing.md,
    borderRadius: VOIDBorderRadius.md,
    borderWidth: 1,
    gap: VOIDSpacing.sm,
  },
  actionButtonFilled: {
    borderWidth: 0,
  },
  actionIcon: {
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
  },
  actionIconFilled: {
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
  },
  actionText: {
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.semibold,
  },
  actionTextFilled: {
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.semibold,
    color: VoidColors.textPrimary,
  },
  transactionsSection: {
    marginBottom: VOIDSpacing.xl,
  },
  sectionTitle: {
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.semibold,
    color: VoidColors.textPrimary,
    marginBottom: VOIDSpacing.md,
  },
  emptyTx: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.xl,
    alignItems: 'center',
  },
  emptyTxIcon: {
    fontSize: 40,
    marginBottom: VOIDSpacing.md,
  },
  emptyTxText: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textSecondary,
    marginBottom: VOIDSpacing.xs,
  },
  emptyTxSubtext: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
  },
  txList: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    overflow: 'hidden',
  },
  txItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: VOIDSpacing.md,
    borderBottomWidth: 1,
    borderBottomColor: VoidColors.border,
  },
  txLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  txIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: VOIDSpacing.md,
  },
  txIconText: {
    color: VoidColors.textPrimary,
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
  },
  txInfo: {},
  txType: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textPrimary,
    fontWeight: VOIDTypography.fontWeight.medium,
  },
  txId: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textPrimary,
    fontWeight: VOIDTypography.fontWeight.medium,
    fontFamily: 'monospace',
  },
  txViewLink: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.primary,
    fontWeight: VOIDTypography.fontWeight.medium,
  },
  txDate: {
    fontSize: VOIDTypography.fontSize.xs,
    color: VoidColors.textMuted,
    marginTop: 2,
  },
  txRight: {
    alignItems: 'flex-end',
  },
  txAmount: {
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.semibold,
    fontFamily: 'monospace',
  },
  txConfirmations: {
    fontSize: VOIDTypography.fontSize.xs,
    color: VoidColors.textMuted,
    marginTop: 2,
  },
  infoSection: {
    marginBottom: VOIDSpacing.xl,
  },
  infoCard: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.md,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: VOIDSpacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: VoidColors.border,
  },
  infoLabel: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
    flex: 1,
  },
  infoValue: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textPrimary,
    flex: 2,
    textAlign: 'right',
  },
  infoValueMono: {
    fontFamily: 'monospace',
    fontSize: VOIDTypography.fontSize.xs,
  },
  exportButton: {
    backgroundColor: 'transparent',
    borderRadius: VOIDBorderRadius.md,
    paddingVertical: VOIDSpacing.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: VoidColors.warning,
  },
  exportButtonText: {
    color: VoidColors.warning,
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.semibold,
  },
});

export default VoidWalletDetailScreen;
