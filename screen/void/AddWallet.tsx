/**
 * Add Wallet Screen
 * Create new or import existing VOID or VOID wallet
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  ScrollView,
  Image,
} from 'react-native';
import { VoidColors, VOIDSpacing, VOIDTypography, VOIDBorderRadius, VOIDShadows } from '../../components/VoidTheme';
import * as bip39 from 'bip39';
import { saveWallet } from '../../class/void-wallet-storage';
import { useScreenProtect } from '../../hooks/useScreenProtect';

// Coin logos
const VOID_LOGO = require('../../img/void-logo-small.png');
const VOID_LOGO = require('../../img/void-logo-small.png');

interface AddWalletProps {
  navigation: any;
}

type WalletType = 'void' | 'void' | 'bc1';
type Mode = 'select' | 'create-void' | 'create-void' | 'import-void' | 'import-void';

export const AddWalletScreen: React.FC<AddWalletProps> = ({ navigation }) => {
  const [mode, setMode] = useState<Mode>('select');
  const [loading, setLoading] = useState(false);
  const [mnemonic, setMnemonic] = useState('');
  const [importMnemonic, setImportMnemonic] = useState('');
  const [walletLabel, setWalletLabel] = useState('');
  const { enableScreenProtect, disableScreenProtect } = useScreenProtect();

  // Enable screenshot protection when mnemonic is displayed or being imported
  useEffect(() => {
    const showsMnemonic = mnemonic && (mode === 'create-void' || mode === 'create-void');
    const importingMnemonic = importMnemonic && (mode === 'import-void' || mode === 'import-void');
    if (showsMnemonic || importingMnemonic) {
      enableScreenProtect();
    } else {
      disableScreenProtect();
    }
    return () => { disableScreenProtect(); };
  }, [mnemonic, importMnemonic, mode]);

  // Clear sensitive state on unmount
  useEffect(() => {
    return () => {
      setMnemonic('');
      setImportMnemonic('');
    };
  }, []);

  const getCurrentWalletType = (): WalletType => {
    if (mode === 'create-void' || mode === 'import-void') return 'void';
    return 'void';
  };

  const generateNewWallet = async (walletType: WalletType) => {
    setLoading(true);
    try {
      // Generate 12-word mnemonic
      const newMnemonic = bip39.generateMnemonic(128);
      setMnemonic(newMnemonic);
      setWalletLabel('');
      setMode(walletType === 'void' ? 'create-void' : 'create-void');
    } catch (error: any) {
      Alert.alert('Error', 'Failed to generate wallet');
    } finally {
      setLoading(false);
    }
  };

  const confirmNewWallet = async () => {
    if (!walletLabel.trim()) {
      Alert.alert('Error', 'Please enter a wallet name');
      return;
    }

    const walletType = getCurrentWalletType();
    const coinName = walletType === 'void' ? 'VOID' : 'VOID';

    setLoading(true);
    try {
      const wallet = await saveWallet(walletLabel, mnemonic, walletType);
      setMnemonic('');

      Alert.alert(
        'Wallet Created',
        `Your ${coinName} wallet has been created. Make sure to backup your recovery phrase!`,
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (error: any) {
      Alert.alert('Error', error?.message || 'Failed to save wallet');
    } finally {
      setLoading(false);
    }
  };

  const importWallet = async () => {
    if (!importMnemonic.trim()) {
      Alert.alert('Error', 'Please enter your recovery phrase');
      return;
    }

    const words = importMnemonic.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      Alert.alert('Error', 'Recovery phrase must be 12 or 24 words');
      return;
    }

    if (!bip39.validateMnemonic(importMnemonic.trim())) {
      Alert.alert('Error', 'Invalid recovery phrase');
      return;
    }

    if (!walletLabel.trim()) {
      Alert.alert('Error', 'Please enter a wallet name');
      return;
    }

    const walletType = getCurrentWalletType();
    const coinName = walletType === 'void' ? 'VOID' : 'VOID';

    setLoading(true);
    try {
      const wallet = await saveWallet(walletLabel, importMnemonic.trim(), walletType);
      setImportMnemonic('');

      Alert.alert(
        'Wallet Imported',
        `Your ${coinName} wallet has been imported successfully!`,
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (error: any) {
      Alert.alert('Error', error?.message || 'Failed to import wallet');
    } finally {
      setLoading(false);
    }
  };

  const goToImport = (walletType: WalletType) => {
    setImportMnemonic('');
    setWalletLabel('');
    setMode(walletType === 'void' ? 'import-void' : 'import-void');
  };

  // Main selection screen
  if (mode === 'select') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>Add Wallet</Text>
        <Text style={styles.subtitle}>Choose which wallet to create or import</Text>

        {/* VOID Section */}
        <View style={styles.sectionHeader}>
          <Image source={VOID_LOGO} style={styles.sectionLogo} resizeMode="contain" />
          <Text style={[styles.sectionTitle, { color: VoidColors.primary }]}>VoidCoin (VOID)</Text>
        </View>

        <TouchableOpacity
          style={[styles.optionCard, { borderColor: VoidColors.primary }]}
          onPress={() => generateNewWallet('void')}
          disabled={loading}
          accessibilityLabel="Create a new VOID wallet with recovery phrase"
          accessibilityRole="button"
        >
          {loading ? (
            <ActivityIndicator color={VoidColors.primary} />
          ) : (
            <>
              <Text style={styles.optionIcon}>✨</Text>
              <View style={styles.optionText}>
                <Text style={styles.optionTitle}>Create VOID Wallet</Text>
                <Text style={styles.optionDesc}>Generate a new VOID wallet with recovery phrase</Text>
              </View>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.optionCard, { borderColor: VoidColors.primary }]}
          onPress={() => goToImport('void')}
          accessibilityLabel="Import a VOID wallet using recovery phrase"
          accessibilityRole="button"
        >
          <Text style={styles.optionIcon}>📥</Text>
          <View style={styles.optionText}>
            <Text style={styles.optionTitle}>Import VOID Wallet</Text>
            <Text style={styles.optionDesc}>Restore using your 12 or 24 word recovery phrase</Text>
          </View>
        </TouchableOpacity>

        {/* VOID Section */}
        <View style={[styles.sectionHeader, { marginTop: VOIDSpacing.xl }]}>
          <Image source={VOID_LOGO} style={styles.sectionLogo} resizeMode="contain" />
          <Text style={[styles.sectionTitle, { color: VoidColors.voidPrimary }]}>BitcoinII (VOID)</Text>
        </View>

        <TouchableOpacity
          style={[styles.optionCard, { borderColor: VoidColors.voidPrimary }]}
          onPress={() => generateNewWallet('void')}
          disabled={loading}
          accessibilityLabel="Create a new VOID wallet with recovery phrase"
          accessibilityRole="button"
        >
          {loading ? (
            <ActivityIndicator color={VoidColors.voidPrimary} />
          ) : (
            <>
              <Text style={styles.optionIcon}>✨</Text>
              <View style={styles.optionText}>
                <Text style={styles.optionTitle}>Create VOID Wallet</Text>
                <Text style={styles.optionDesc}>Generate a new VOID wallet with recovery phrase</Text>
              </View>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.optionCard, { borderColor: VoidColors.voidPrimary }]}
          onPress={() => goToImport('void')}
          accessibilityLabel="Import a VOID wallet using recovery phrase"
          accessibilityRole="button"
        >
          <Text style={styles.optionIcon}>📥</Text>
          <View style={styles.optionText}>
            <Text style={styles.optionTitle}>Import VOID Wallet</Text>
            <Text style={styles.optionDesc}>Restore using your 12 or 24 word recovery phrase</Text>
          </View>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // Create wallet screen (VOID or VOID)
  if (mode === 'create-void' || mode === 'create-void') {
    const walletType = getCurrentWalletType();
    const coinName = walletType === 'void' ? 'VOID' : 'VOID';
    const primaryColor = walletType === 'void' ? VoidColors.voidPrimary : VoidColors.primary;
    const logo = walletType === 'void' ? VOID_LOGO : VOID_LOGO;

    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
        <View style={styles.createHeader}>
          <Image source={logo} style={styles.createLogo} resizeMode="contain" />
          <Text style={styles.title}>New {coinName} Wallet</Text>
        </View>
        <Text style={styles.subtitle}>Write down these 12 words and keep them safe. Never share them!</Text>

        <View style={[styles.mnemonicBox, { borderColor: primaryColor }]}>
          {mnemonic.split(' ').map((word, index) => (
            <View key={index} style={styles.wordChip}>
              <Text style={styles.wordNumber}>{index + 1}</Text>
              <Text style={styles.wordText}>{word}</Text>
            </View>
          ))}
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Wallet Name</Text>
          <TextInput
            style={styles.input}
            value={walletLabel}
            onChangeText={setWalletLabel}
            placeholder={`My ${coinName} Wallet`}
            placeholderTextColor={VoidColors.textMuted}
            maxLength={50}
          />
        </View>

        <TouchableOpacity
          style={[styles.primaryButton, { backgroundColor: primaryColor }]}
          onPress={confirmNewWallet}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color={VoidColors.textPrimary} />
          ) : (
            <Text style={styles.primaryButtonText}>I've Saved My Phrase</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryButton} onPress={() => { setMnemonic(''); setMode('select'); }}>
          <Text style={styles.secondaryButtonText}>Back</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // Import wallet screen (VOID or VOID)
  const walletType = getCurrentWalletType();
  const coinName = walletType === 'void' ? 'VOID' : 'VOID';
  const primaryColor = walletType === 'void' ? VoidColors.voidPrimary : VoidColors.primary;
  const logo = walletType === 'void' ? VOID_LOGO : VOID_LOGO;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <View style={styles.createHeader}>
        <Image source={logo} style={styles.createLogo} resizeMode="contain" />
        <Text style={styles.title}>Import {coinName} Wallet</Text>
      </View>
      <Text style={styles.subtitle}>Enter your 12 or 24 word recovery phrase</Text>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Recovery Phrase</Text>
        <TextInput
          style={[styles.input, styles.mnemonicInput]}
          value={importMnemonic}
          onChangeText={setImportMnemonic}
          placeholder="Enter your recovery phrase..."
          placeholderTextColor={VoidColors.textMuted}
          multiline
          numberOfLines={4}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          importantForAutofill="no"
          spellCheck={false}
          maxLength={500}
          accessibilityLabel="Recovery phrase, enter 12 or 24 words separated by spaces"
        />
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Wallet Name</Text>
        <TextInput
          style={styles.input}
          value={walletLabel}
          onChangeText={setWalletLabel}
          placeholder={`My ${coinName} Wallet`}
          placeholderTextColor={VoidColors.textMuted}
          maxLength={50}
        />
      </View>

      <TouchableOpacity
        style={[styles.primaryButton, { backgroundColor: primaryColor }]}
        onPress={importWallet}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color={VoidColors.textPrimary} />
        ) : (
          <Text style={styles.primaryButtonText}>Import Wallet</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity style={styles.secondaryButton} onPress={() => { setImportMnemonic(''); setWalletLabel(''); setMode('select'); }}>
        <Text style={styles.secondaryButtonText}>Back</Text>
      </TouchableOpacity>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: VoidColors.background,
  },
  scrollContent: {
    padding: VOIDSpacing.lg,
    paddingBottom: VOIDSpacing.xxl,
  },
  title: {
    fontSize: VOIDTypography.fontSize.xxl,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
    textAlign: 'center',
    marginBottom: VOIDSpacing.sm,
  },
  subtitle: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textSecondary,
    textAlign: 'center',
    marginBottom: VOIDSpacing.xl,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: VOIDSpacing.md,
    marginTop: VOIDSpacing.md,
  },
  sectionLogo: {
    width: 32,
    height: 32,
    marginRight: VOIDSpacing.sm,
  },
  sectionTitle: {
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
  },
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.lg,
    padding: VOIDSpacing.lg,
    marginBottom: VOIDSpacing.md,
    borderWidth: 1,
  },
  optionIcon: {
    fontSize: 32,
    marginRight: VOIDSpacing.md,
  },
  optionText: {
    flex: 1,
  },
  optionTitle: {
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.semibold,
    color: VoidColors.textPrimary,
    marginBottom: VOIDSpacing.xs,
  },
  optionDesc: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
  },
  createHeader: {
    alignItems: 'center',
    marginBottom: VOIDSpacing.md,
  },
  createLogo: {
    width: 64,
    height: 64,
    marginBottom: VOIDSpacing.sm,
  },
  mnemonicBox: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.lg,
    padding: VOIDSpacing.md,
    marginBottom: VOIDSpacing.xl,
    borderWidth: 1,
  },
  wordChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: VoidColors.backgroundElevated,
    borderRadius: VOIDBorderRadius.sm,
    paddingVertical: VOIDSpacing.sm,
    paddingHorizontal: VOIDSpacing.md,
    margin: VOIDSpacing.xs,
  },
  wordNumber: {
    fontSize: VOIDTypography.fontSize.xs,
    color: VoidColors.textMuted,
    marginRight: VOIDSpacing.xs,
  },
  wordText: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textPrimary,
    fontFamily: 'monospace',
  },
  inputGroup: {
    marginBottom: VOIDSpacing.lg,
  },
  inputLabel: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
    marginBottom: VOIDSpacing.sm,
  },
  input: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    borderWidth: 1,
    borderColor: VoidColors.border,
    padding: VOIDSpacing.md,
    color: VoidColors.textPrimary,
    fontSize: VOIDTypography.fontSize.base,
  },
  mnemonicInput: {
    height: 100,
    textAlignVertical: 'top',
  },
  primaryButton: {
    borderRadius: VOIDBorderRadius.md,
    paddingVertical: VOIDSpacing.md,
    alignItems: 'center',
    marginBottom: VOIDSpacing.md,
    ...VOIDShadows.glow,
  },
  primaryButtonText: {
    color: VoidColors.textPrimary,
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
  },
  secondaryButton: {
    paddingVertical: VOIDSpacing.md,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: VoidColors.textSecondary,
    fontSize: VOIDTypography.fontSize.base,
  },
  errorText: {
    color: VoidColors.error,
    fontSize: VOIDTypography.fontSize.sm,
    textAlign: 'center',
    marginBottom: VOIDSpacing.md,
  },
});

export default AddWalletScreen;
