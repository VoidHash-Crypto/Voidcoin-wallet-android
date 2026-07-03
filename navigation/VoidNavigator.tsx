/**
 * VOID Stack Navigator
 * Main navigation for VOID wallet screens
 */

import React from 'react';
import { View, Text } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { VoidColors, VOIDTypography } from '../components/VoidTheme';
import { VOIDRootStackParamList } from './VOIDNavigationTypes';

// Import screens
import VoidWalletList from '../screen/void/VoidWalletList';
import ClaimAirdrop from '../screen/void/ClaimAirdrop';
import VoidReceive from '../screen/void/VoidReceive';
import VoidSend from '../screen/void/VoidSend';
import VoidSettings from '../screen/void/VoidSettings';
import VoidWalletDetail from '../screen/void/VoidWalletDetail';
import AddWallet from '../screen/void/AddWallet';
import VoidAppPassword from '../screen/void/VoidAppPassword';
import { getWallet, getWalletMnemonic, updateWalletBalance, StoredWallet } from '../class/void-wallet-storage';
import { getTransactionsByAddress, getVOIDTransactions, getBalanceByAddress, getVoidBalance, getBalanceByScripthash, getTransactionsByScripthash } from '../blue_modules/VoidElectrum';
import { sendTransaction, sendFromBech32, sendFromP2SH } from '../class/void-transaction';
import { bc1AddressToScripthash } from '../class/void-airdrop';

const Stack = createNativeStackNavigator<VOIDRootStackParamList>();

const defaultScreenOptions = {
  headerStyle: {
    backgroundColor: VoidColors.backgroundSecondary,
  },
  headerTintColor: VoidColors.textPrimary,
  headerTitleStyle: {
    fontWeight: VOIDTypography.fontWeight.semibold,
    fontSize: VOIDTypography.fontSize.lg,
  },
  headerShadowVisible: false,
  contentStyle: {
    backgroundColor: VoidColors.background,
  },
  animation: 'slide_from_right' as const,
};

export const VoidNavigator: React.FC = () => {
  return (
    <Stack.Navigator
      initialRouteName="VoidWalletList"
      screenOptions={defaultScreenOptions}
    >
      <Stack.Screen
        name="VoidWalletList"
        component={VoidWalletList}
        options={{
          headerShown: false,
          title: 'VOID Wallet',
        }}
      />

      <Stack.Screen
        name="ClaimAirdrop"
        component={ClaimAirdrop}
        options={{
          title: 'Claim VOID',
          headerBackTitle: 'Back',
        }}
      />

      <Stack.Screen
        name="VoidReceive"
        component={VoidReceiveWrapper}
        options={{
          title: 'Receive',
          headerBackTitle: 'Back',
        }}
      />

      <Stack.Screen
        name="VoidSend"
        component={VoidSendWrapper}
        options={{
          title: 'Send',
          headerBackTitle: 'Back',
        }}
      />

      <Stack.Screen
        name="VoidSettings"
        component={VoidSettings}
        options={{
          title: 'Settings',
          headerBackTitle: 'Back',
        }}
      />

      <Stack.Screen
        name="WalletDetail"
        component={VoidWalletDetailWrapper}
        options={{
          title: 'Wallet',
          headerBackTitle: 'Back',
        }}
      />

      <Stack.Screen
        name="AddWallet"
        component={AddWallet}
        options={{
          title: 'Add Wallet',
          headerBackTitle: 'Back',
        }}
      />

      <Stack.Screen
        name="VoidAppPassword"
        component={VoidAppPassword}
        options={{
          title: 'App Password',
          headerBackTitle: 'Back',
        }}
      />
    </Stack.Navigator>
  );
};

// Wrapper components to handle route params
import { useRoute, useNavigation } from '@react-navigation/native';
import { VoidReceiveRouteProp, VoidSendRouteProp, WalletDetailRouteProp } from './VOIDNavigationTypes';

const VoidReceiveWrapper: React.FC = () => {
  const route = useRoute<VoidReceiveRouteProp>();
  const { address, walletLabel, isVOID } = route.params;

  return (
    <VoidReceive
      address={address}
      walletLabel={walletLabel}
      isVOID={isVOID}
    />
  );
};

const VoidSendWrapper: React.FC = () => {
  const route = useRoute<VoidSendRouteProp>();
  const navigation = useNavigation();
  const { walletId, walletBalance, walletAddress, isVOID } = route.params;

  const handleSend = async (toAddress: string, amount: number, feePerByte: number): Promise<{ txid: string }> => {
    const mnemonic = await getWalletMnemonic(walletId);
    if (!mnemonic) {
      throw new Error('Could not retrieve wallet keys');
    }

    const isBech32Source = walletAddress.toLowerCase().startsWith('bc1');
    const isP2SHSource = walletAddress.startsWith('3');

    let result;
    if (isBech32Source && !isVOID) {
      result = await sendFromBech32(mnemonic, walletAddress, toAddress, amount, feePerByte);
    } else if (isP2SHSource && !isVOID) {
      result = await sendFromP2SH(mnemonic, walletAddress, toAddress, amount, feePerByte);
    } else {
      result = await sendTransaction(mnemonic, toAddress, amount, feePerByte, isVOID || false, walletAddress);
    }

    return { txid: result.txid };
  };

  return (
    <VoidSend
      walletBalance={walletBalance}
      walletAddress={walletAddress}
      isVOID={isVOID}
      onSend={handleSend}
      navigation={navigation}
    />
  );
};

interface Transaction {
  txid: string;
  confirmations: number;
  amount: number;
  timestamp: number;
  height?: number;
}

const VoidWalletDetailWrapper: React.FC = () => {
  const route = useRoute<WalletDetailRouteProp>();
  const navigation = useNavigation();
  const { walletId } = route.params;
  const [wallet, setWallet] = React.useState<StoredWallet | null>(null);
  const [transactions, setTransactions] = React.useState<Transaction[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const fetchWalletData = React.useCallback(async (w: StoredWallet) => {
    try {
      const isVOID = w.type === 'void';
      const isBC1 = w.type === 'bc1' || w.address.toLowerCase().startsWith('bc1');

      let balance: { confirmed: number; unconfirmed: number };
      let txHistory: any[];

      if (isVOID) {
        balance = await getVoidBalance(w.address);
        txHistory = await getVOIDTransactions(w.address);
      } else if (isBC1) {
        // bc1 addresses need scripthash-based queries
        const scripthash = bc1AddressToScripthash(w.address);
        if (!scripthash) {
          throw new Error('Invalid bc1 address');
        }
        balance = await getBalanceByScripthash(scripthash);
        txHistory = await getTransactionsByScripthash(scripthash);
      } else {
        // Standard VOID CashAddr
        balance = await getBalanceByAddress(w.address);
        txHistory = await getTransactionsByAddress(w.address);
      }

      // Convert to Transaction format
      const formattedTxs: Transaction[] = txHistory.map((tx: any) => ({
        txid: tx.tx_hash || tx.txid,
        confirmations: tx.height ? Math.max(0, (tx.height > 0 ? 1 : 0)) : 0, // Simplified - would need current block height
        amount: 0, // Amount requires fetching full tx details
        timestamp: Math.floor(Date.now() / 1000), // Would need tx details for actual time
        height: tx.height,
      }));

      setTransactions(formattedTxs);

      // Update wallet with new balance (both React state and persistent storage)
      setWallet(prev => prev ? {
        ...prev,
        balance: balance.confirmed,
        unconfirmedBalance: balance.unconfirmed,
      } : null);
      updateWalletBalance(w.id, balance.confirmed, balance.unconfirmed).catch(() => {});
    } catch (error) {
      __DEV__ && console.log('Failed to fetch wallet data:', error);
    }
  }, []);

  React.useEffect(() => {
    const loadWallet = async () => {
      const w = await getWallet(walletId);
      setWallet(w);
      if (w) {
        await fetchWalletData(w);
      }
      setLoading(false);
    };
    loadWallet();
  }, [walletId, fetchWalletData]);

  const handleRefresh = React.useCallback(async () => {
    if (!wallet) return;
    setRefreshing(true);
    await fetchWalletData(wallet);
    setRefreshing(false);
  }, [wallet, fetchWalletData]);

  if (loading || !wallet) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0a' }}>
        <Text style={{ color: '#888', fontSize: 16 }}>Loading wallet...</Text>
      </View>
    );
  }

  return (
    <VoidWalletDetail
      walletId={walletId}
      label={wallet.label}
      balance={wallet.balance}
      unconfirmedBalance={wallet.unconfirmedBalance}
      address={wallet.address}
      isVOID={wallet.type === 'void'}
      transactions={transactions}
      navigation={navigation}
      onRefresh={handleRefresh}
      refreshing={refreshing}
    />
  );
};

export default VoidNavigator;
