/**
 * VOID Wallet List Screen
 * Main screen showing VOID and VOID wallets
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Image,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { VoidColors, VOIDSpacing, VOIDTypography, VOIDBorderRadius, VOIDShadows } from '../../components/VoidTheme';
import VoidWalletCard from '../../components/VoidWalletCard';
import { getWallets, StoredWallet, updateWalletBalance } from '../../class/void-wallet-storage';
import { getBalanceByAddress, getVoidBalance, getBalanceByScripthash, isConnected as isElectrumConnected } from '../../blue_modules/VoidElectrum';
import { bc1AddressToScripthash } from '../../class/void-airdrop';

interface Wallet {
  id: string;
  type: 'void' | 'bc1';
  label: string;
  balance: number;
  unconfirmedBalance: number;
  address: string;
}

export const VoidWalletListScreen: React.FC<{ navigation: any }> = ({ navigation }) => {
  const [refreshing, setRefreshing] = useState(false);
  const [wallets, setWallets] = useState<Wallet[]>([]);

  // Load wallets from storage
  const loadWallets = useCallback(async () => {
    try {
      const storedWallets = await getWallets();
      const mappedWallets: Wallet[] = storedWallets.map((w: StoredWallet) => ({
        id: w.id,
        type: w.type,
        label: w.label,
        balance: w.balance,
        unconfirmedBalance: w.unconfirmedBalance,
        address: w.address,
      }));
      setWallets(mappedWallets);
    } catch (error) {
      __DEV__ && console.error('Failed to load wallets:', error);
    }
  }, []);

  // Load wallets and fetch balances when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      const fetchBalances = async () => {
        await loadWallets();
        // Fetch balances in parallel for all wallets
        const storedWallets = await getWallets();
        await Promise.all(storedWallets.map(async (wallet) => {
          try {
            let balance;
            if (wallet.type === 'void') {
              balance = await getVoidBalance(wallet.address);
            } else if (wallet.type === 'bc1' || wallet.address.toLowerCase().startsWith('bc1')) {
              const scripthash = bc1AddressToScripthash(wallet.address);
              if (!scripthash) throw new Error('Invalid bc1 address');
              balance = await getBalanceByScripthash(scripthash);
            } else {
              balance = await getBalanceByAddress(wallet.address);
            }
            await updateWalletBalance(wallet.id, balance.confirmed, balance.unconfirmed);
          } catch (error) {
            __DEV__ && console.error('Failed to fetch balance:', error);
          }
        }));
        // Reload with updated balances
        await loadWallets();
      };
      fetchBalances();
    }, [loadWallets])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const storedWallets = await getWallets();

      // Fetch updated balances in parallel for all wallets
      await Promise.all(storedWallets.map(async (wallet) => {
        try {
          let balance;
          if (wallet.type === 'void') {
            balance = await getVoidBalance(wallet.address);
          } else if (wallet.type === 'bc1' || wallet.address.toLowerCase().startsWith('bc1')) {
            const scripthash = bc1AddressToScripthash(wallet.address);
            if (!scripthash) throw new Error('Invalid bc1 address');
            balance = await getBalanceByScripthash(scripthash);
          } else {
            balance = await getBalanceByAddress(wallet.address);
          }

          await updateWalletBalance(wallet.id, balance.confirmed, balance.unconfirmed);
        } catch (error) {
          __DEV__ && console.error('Failed to fetch balance:', error);
        }
      }));

      // Reload wallets with updated balances
      await loadWallets();
    } catch (error) {
      __DEV__ && console.error('Failed to refresh wallets:', error);
    }
    setRefreshing(false);
  }, [loadWallets]);

  const navigateToClaimAirdrop = () => {
    navigation.navigate('ClaimAirdrop');
  };

  const navigateToAddWallet = () => {
    navigation.navigate('AddWallet');
  };

  const voidWallets = useMemo(() => wallets.filter(w => w.type === 'void'), [wallets]);
  const bc1Wallets = useMemo(() => wallets.filter(w => w.type === 'bc1'), [wallets]);
  const voidWallets = useMemo(() => wallets.filter(w => w.type === 'void'), [wallets]);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.logoContainer}>
          <Image
            source={require('../../img/void-logo-small.png')}
            style={styles.logoImage}
            resizeMode="contain"
            accessibilityLabel="VOID Wallet logo"
          />
          <Text style={styles.logoSubtext}>Wallet</Text>
        </View>
        <TouchableOpacity
          onPress={() => navigation.navigate('VoidSettings')}
          accessibilityLabel="Settings"
          accessibilityRole="button"
        >
          <Text style={styles.settingsIcon}>⚙️</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={VoidColors.primary}
          />
        }
      >
        {/* Airdrop Banner */}
        <TouchableOpacity style={styles.airdropBanner} onPress={navigateToClaimAirdrop} accessibilityLabel="Claim your VOID airdrop. Import your VOID wallet to claim your VOID." accessibilityRole="button">
          <View style={styles.airdropContent}>
            <Text style={styles.airdropTitle}>🎉 Claim Your VOID Airdrop</Text>
            <Text style={styles.airdropText}>
              Import your VOID wallet to claim your VOID
            </Text>
          </View>
          <Text style={styles.airdropArrow}>→</Text>
        </TouchableOpacity>

        {/* Wallets */}
        {wallets.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>💰</Text>
            <Text style={styles.emptyTitle}>No Wallets Yet</Text>
            <Text style={styles.emptyText}>
              Create a new wallet or import an existing one to get started
            </Text>
            <View style={styles.emptyActions}>
              <TouchableOpacity
                style={styles.createButton}
                onPress={navigateToAddWallet}
                accessibilityLabel="Create a new wallet"
                accessibilityRole="button"
              >
                <Text style={styles.createButtonText}>Create Wallet</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.importButton}
                onPress={navigateToClaimAirdrop}
                accessibilityLabel="Import a VOID wallet"
                accessibilityRole="button"
              >
                <Text style={styles.importButtonText}>Import VOID Wallet</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <>
            {/* VOID Wallets Section */}
            {voidWallets.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>VOID Wallets</Text>
                {voidWallets.map(wallet => (
                  <VoidWalletCard
                    key={wallet.id}
                    walletLabel={wallet.label}
                    balance={wallet.balance}
                    unconfirmedBalance={wallet.unconfirmedBalance}
                    address={wallet.address}
                    isVoid={true}
                    onPress={() => navigation.navigate('WalletDetail', { walletId: wallet.id })}
                    onReceive={() => navigation.navigate('VoidReceive', { address: wallet.address, walletLabel: wallet.label, isVoid: true })}
                    onSend={() => navigation.navigate('VoidSend', { walletId: wallet.id, walletBalance: wallet.balance, walletAddress: wallet.address, isVoid: true })}
                  />
                ))}
              </View>
            )}

            {/* bc1 SegWit Wallets Section (airdrop claims) */}
            {bc1Wallets.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>SegWit Wallets (Airdrop)</Text>
                {bc1Wallets.map(wallet => (
                  <VoidWalletCard
                    key={wallet.id}
                    walletLabel={wallet.label}
                    balance={wallet.balance}
                    unconfirmedBalance={wallet.unconfirmedBalance}
                    address={wallet.address}
                    isVoid={false}
                    onPress={() => navigation.navigate('WalletDetail', { walletId: wallet.id })}
                    onReceive={() => navigation.navigate('VoidReceive', { address: wallet.address, walletLabel: wallet.label, isVoid: false })}
                    onSend={() => navigation.navigate('VoidSend', { walletId: wallet.id, walletBalance: wallet.balance, walletAddress: wallet.address, isVoid: false })}
                  />
                ))}
              </View>
            )}

            {/* VOID Wallets Section */}
            {voidWallets.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>VOID Wallets</Text>
                {voidWallets.map(wallet => (
                  <VoidWalletCard
                    key={wallet.id}
                    walletLabel={wallet.label}
                    balance={wallet.balance}
                    unconfirmedBalance={wallet.unconfirmedBalance}
                    address={wallet.address}
                    isVoid={false}
                    onPress={() => navigation.navigate('WalletDetail', { walletId: wallet.id })}
                    onReceive={() => navigation.navigate('VoidReceive', { address: wallet.address, walletLabel: wallet.label, isVoid: false })}
                    onSend={() => navigation.navigate('VoidSend', { walletId: wallet.id, walletBalance: wallet.balance, walletAddress: wallet.address, isVoid: false })}
                  />
                ))}
              </View>
            )}
          </>
        )}

        {/* Network Status */}
        <View style={styles.networkStatus} accessibilityLabel={isElectrumConnected() ? 'Network status: connected to VOID network' : 'Network status: disconnected'} accessibilityRole="text">
          <View style={[styles.statusDot, !isElectrumConnected() && { backgroundColor: '#f85149' }]} />
          <Text style={styles.statusText}>{isElectrumConnected() ? 'Connected to VOID Network' : 'Disconnected'}</Text>
        </View>
      </ScrollView>

      {/* Add Wallet FAB */}
      {wallets.length > 0 && (
        <TouchableOpacity style={styles.fab} onPress={navigateToAddWallet} accessibilityLabel="Add wallet" accessibilityRole="button">
          <Text style={styles.fabText}>+</Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: VoidColors.background,
  },
  header: {
    paddingTop: 60,
    paddingBottom: VOIDSpacing.lg,
    paddingHorizontal: VOIDSpacing.lg,
    backgroundColor: VoidColors.backgroundSecondary,
    borderBottomWidth: 1,
    borderBottomColor: VoidColors.border,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  logoContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logoImage: {
    width: 40,
    height: 40,
    marginRight: VOIDSpacing.sm,
  },
  logoSubtext: {
    fontSize: VOIDTypography.fontSize.xl,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
  },
  settingsIcon: {
    fontSize: 24,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: VOIDSpacing.md,
    paddingBottom: 100,
  },
  airdropBanner: {
    backgroundColor: VoidColors.primaryGlow,
    borderRadius: VOIDBorderRadius.lg,
    padding: VOIDSpacing.lg,
    marginBottom: VOIDSpacing.lg,
    borderWidth: 1,
    borderColor: VoidColors.primary,
    flexDirection: 'row',
    alignItems: 'center',
  },
  airdropContent: {
    flex: 1,
  },
  airdropTitle: {
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.primary,
    marginBottom: VOIDSpacing.xs,
  },
  airdropText: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
  },
  airdropArrow: {
    fontSize: VOIDTypography.fontSize.xl,
    color: VoidColors.primary,
  },
  section: {
    marginBottom: VOIDSpacing.lg,
  },
  sectionTitle: {
    fontSize: VOIDTypography.fontSize.sm,
    fontWeight: VOIDTypography.fontWeight.semibold,
    color: VoidColors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginLeft: VOIDSpacing.md,
    marginBottom: VOIDSpacing.sm,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: VOIDSpacing.xxl,
    paddingHorizontal: VOIDSpacing.lg,
  },
  emptyIcon: {
    fontSize: 64,
    marginBottom: VOIDSpacing.lg,
  },
  emptyTitle: {
    fontSize: VOIDTypography.fontSize.xl,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
    marginBottom: VOIDSpacing.sm,
  },
  emptyText: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textSecondary,
    textAlign: 'center',
    marginBottom: VOIDSpacing.xl,
  },
  emptyActions: {
    width: '100%',
    gap: VOIDSpacing.md,
  },
  createButton: {
    backgroundColor: VoidColors.primary,
    borderRadius: VOIDBorderRadius.md,
    paddingVertical: VOIDSpacing.md,
    alignItems: 'center',
    ...VOIDShadows.glow,
  },
  createButtonText: {
    color: VoidColors.textPrimary,
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
  },
  importButton: {
    backgroundColor: 'transparent',
    borderRadius: VOIDBorderRadius.md,
    paddingVertical: VOIDSpacing.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: VoidColors.primary,
  },
  importButtonText: {
    color: VoidColors.primary,
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.semibold,
  },
  networkStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: VOIDSpacing.md,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: VoidColors.success,
    marginRight: VOIDSpacing.sm,
  },
  statusText: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
  },
  fab: {
    position: 'absolute',
    bottom: VOIDSpacing.xl,
    right: VOIDSpacing.xl,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: VoidColors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...VOIDShadows.lg,
  },
  fabText: {
    fontSize: 32,
    color: VoidColors.textPrimary,
    marginTop: -2,
  },
});

export default VoidWalletListScreen;
