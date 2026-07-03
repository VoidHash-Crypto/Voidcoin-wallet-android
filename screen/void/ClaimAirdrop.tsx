/**
 * VOID Airdrop Claim Wizard
 * Guided 5-step flow to claim VOID from VOID wallets
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Image,
} from 'react-native';

const VOID_LOGO = require('../../img/void-logo-small.png');
const VOID_LOGO = require('../../img/void-logo-small.png');
import { VoidColors, VOIDSpacing, VOIDTypography, VOIDShadows, VOIDBorderRadius } from '../../components/VoidTheme';
import {
  claimFromWIF,
  claimFromMnemonic,
  scanDescriptorForAirdrop,
  getAntiGamingStatus,
  buildScanResult,
  AirdropClaimResult,
  AirdropScanResult,
} from '../../class/void-airdrop';
import { saveWallet } from '../../class/void-wallet-storage';
import { useNavigation } from '@react-navigation/native';
import { PasswordInput, PasswordInputHandle } from '../../components/PasswordInput';
import { useScreenProtect } from '../../hooks/useScreenProtect';

// ============================================================================
// Types & Config
// ============================================================================

type WalletTypeId = 'bitcoin-core' | 'electrum' | 'mobile-bip39' | 'hardware' | 'paper-wallet' | 'other';
type InputMode = 'wif' | 'phrase' | 'descriptor';

interface WalletTypeConfig {
  id: WalletTypeId;
  label: string;
  icon: string;
  description: string;
  inputMode: InputMode;
  inputLabel: string;
  inputPlaceholder: string;
  multiline: boolean;
  warning?: string;
  helperText: string;
  instructions: string[];
}

const WALLET_TYPES: WalletTypeConfig[] = [
  {
    id: 'bitcoin-core',
    label: 'Bitcoin Core',
    icon: '>_',
    description: 'Full node wallet',
    inputMode: 'descriptor',
    inputLabel: 'Descriptor or WIF',
    inputPlaceholder: 'Paste listdescriptors output, xprv, or WIF...',
    multiline: true,
    helperText: 'Accepts listdescriptors JSON, xprv key, or single WIF',
    instructions: [
      'Open Bitcoin Core and go to Window > Console',
      'If encrypted, run: walletpassphrase "your-passphrase" 60',
      'Run: listdescriptors true',
      'Copy the entire JSON output and paste it below',
    ],
  },
  {
    id: 'electrum',
    label: 'Electrum',
    icon: '\u26A1',
    description: 'Desktop wallet',
    inputMode: 'phrase',
    inputLabel: '12-Word Recovery Phrase',
    inputPlaceholder: 'Enter your 12 words separated by spaces',
    multiline: true,
    helperText: 'Scans BIP44, BIP84, BIP49, BIP86 paths',
    instructions: [
      'Open Electrum and go to Wallet > Seed',
      'Enter your wallet password when prompted',
      'Copy the 12-word seed phrase shown',
      'Paste it into the field below',
    ],
  },
  {
    id: 'mobile-bip39',
    label: 'Mobile / BIP39',
    icon: '\uD83D\uDCF1',
    description: 'Trust Wallet, Coinomi, etc.',
    inputMode: 'phrase',
    inputLabel: '12/24-Word Recovery Phrase',
    inputPlaceholder: 'Enter your recovery words separated by spaces',
    multiline: true,
    helperText: 'Scans BIP44, BIP84, BIP49, BIP86 paths',
    instructions: [
      'Open your wallet app and go to Settings > Security',
      'Find "Show Recovery Phrase" or "Backup Wallet"',
      'Authenticate and copy your 12 or 24 word phrase',
      'Paste it into the field below',
    ],
  },
  {
    id: 'hardware',
    label: 'Hardware Wallet',
    icon: '\uD83D\uDD11',
    description: 'Ledger, Trezor, etc.',
    inputMode: 'phrase',
    inputLabel: 'Recovery Phrase',
    inputPlaceholder: 'Enter the recovery phrase from your hardware wallet backup',
    multiline: true,
    warning: 'Entering your hardware wallet recovery phrase into any software reduces its security. Only proceed if you understand the risk and plan to move funds to a new wallet afterward.',
    helperText: 'Use the 24-word backup phrase that came with your device',
    instructions: [
      'Locate the recovery phrase card that came with your device',
      'Carefully type each word in order into the field below',
      'After claiming, consider generating a new wallet on the device',
    ],
  },
  {
    id: 'paper-wallet',
    label: 'Paper Wallet',
    icon: '\uD83D\uDCC4',
    description: 'Single private key (WIF)',
    inputMode: 'wif',
    inputLabel: 'Private Key (WIF)',
    inputPlaceholder: '5K... or L... or K...',
    multiline: false,
    helperText: 'Checks Legacy, bc1, 3xxx, and bc1p addresses',
    instructions: [
      'Find your paper wallet or backup with the private key',
      'The key starts with 5, K, or L',
      'Type or paste the full WIF private key into the field below',
    ],
  },
  {
    id: 'other',
    label: 'Other / Unsure',
    icon: '?',
    description: 'Choose input format',
    inputMode: 'wif',
    inputLabel: 'Private Key (WIF)',
    inputPlaceholder: '5K... or L... or K...',
    multiline: false,
    helperText: 'Select the tab matching your input type',
    instructions: [
      'Choose the input type that matches what you have',
      'WIF: a single private key starting with 5, K, or L',
      'Phrase: a 12 or 24-word BIP39 recovery phrase',
      'Descriptor: Bitcoin Core descriptor output or xprv key',
    ],
  },
];

// ============================================================================
// Step Progress Component
// ============================================================================

function StepProgress({ current }: { current: number }) {
  const totalSteps = 5;
  const elements: React.ReactNode[] = [];
  for (let i = 0; i < totalSteps; i++) {
    if (i > 0) {
      elements.push(
        <View
          key={`line-${i}`}
          style={[styles.stepLine, i <= current && styles.stepLineCompleted]}
        />,
      );
    }
    elements.push(
      <View
        key={`dot-${i}`}
        style={[
          styles.stepDot,
          i === current && styles.stepDotActive,
          i < current && styles.stepDotCompleted,
        ]}
      />,
    );
  }
  return <View style={styles.stepProgress}>{elements}</View>;
}

// ============================================================================
// Main Component
// ============================================================================

export const ClaimAirdropScreen: React.FC = () => {
  const navigation = useNavigation();
  const { enableScreenProtect, disableScreenProtect } = useScreenProtect();

  // Wizard state
  const [step, setStep] = useState(0);
  const [walletType, setWalletType] = useState<WalletTypeId | null>(null);
  const [otherInputType, setOtherInputType] = useState<InputMode>('wif');

  // Input state
  const [wifInput, setWifInput] = useState('');
  const [phraseInput, setPhraseInput] = useState('');
  const [descriptorInput, setDescriptorInput] = useState('');
  const [passphrase, setPassphrase] = useState('');

  // Scan results
  const [scanResult, setScanResult] = useState<AirdropScanResult | null>(null);
  const [scanProgress, setScanProgress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [antiGamingWarning, setAntiGamingWarning] = useState<string | null>(null);
  const [antiGamingBlocked, setAntiGamingBlocked] = useState(false);

  // Import state
  const [storedCredentials, setStoredCredentials] = useState<{ type: InputMode; value: string } | null>(null);
  const [showPasswordStep, setShowPasswordStep] = useState(false);
  const [walletPassword, setWalletPassword] = useState('');
  const [walletConfirmPassword, setWalletConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [importing, setImporting] = useState(false);

  const claimPasswordRef = useRef<PasswordInputHandle>(null);
  const claimConfirmPasswordRef = useRef<PasswordInputHandle>(null);

  // Refs to avoid stale closures
  const wifRef = useRef(wifInput);
  wifRef.current = wifInput;
  const phraseRef = useRef(phraseInput);
  phraseRef.current = phraseInput;
  const descriptorRef = useRef(descriptorInput);
  descriptorRef.current = descriptorInput;

  // Enable screenshot protection when sensitive inputs have content
  useEffect(() => {
    const hasSensitiveInput = !!(wifInput || phraseInput || descriptorInput);
    if (hasSensitiveInput) {
      enableScreenProtect();
    } else {
      disableScreenProtect();
    }
    return () => { disableScreenProtect(); };
  }, [wifInput, phraseInput, descriptorInput]);

  // Clear sensitive state on unmount
  useEffect(() => {
    return () => {
      setWifInput('');
      setPhraseInput('');
      setDescriptorInput('');
      setPassphrase('');
      setWalletPassword('');
      setWalletConfirmPassword('');
      setStoredCredentials(null);
    };
  }, []);

  // ============================================================================
  // Helpers
  // ============================================================================

  const getEffectiveInputMode = (): InputMode => {
    if (!walletType) return 'wif';
    if (walletType === 'other') return otherInputType;
    const config = WALLET_TYPES.find(w => w.id === walletType);
    return config?.inputMode ?? 'wif';
  };

  const getWalletConfig = (): WalletTypeConfig | undefined => {
    return WALLET_TYPES.find(w => w.id === walletType);
  };

  const getEffectiveConfig = () => {
    if (walletType === 'other') {
      if (otherInputType === 'phrase') {
        return { inputLabel: 'Recovery Phrase', inputPlaceholder: 'Enter your recovery words...', multiline: true, helperText: 'BIP39 12 or 24 word phrase' };
      }
      if (otherInputType === 'descriptor') {
        return { inputLabel: 'Descriptor or xprv', inputPlaceholder: 'Paste descriptor JSON, xprv, or WIF...', multiline: true, helperText: 'Bitcoin Core descriptor, xprv, or WIF' };
      }
      return { inputLabel: 'Private Key (WIF)', inputPlaceholder: '5K... or L... or K...', multiline: false, helperText: 'Single WIF private key' };
    }
    const config = getWalletConfig();
    return config;
  };

  const hasInput = (): boolean => {
    const mode = getEffectiveInputMode();
    switch (mode) {
      case 'wif': return !!wifRef.current.trim();
      case 'phrase': return !!phraseRef.current.trim();
      case 'descriptor': return !!descriptorRef.current.trim();
    }
  };

  const formatBalance = (sats: number): string => {
    return (sats / 100000000).toFixed(8);
  };

  const getAddressTypeLabel = (type?: string) => {
    switch (type) {
      case 'legacy': return 'Legacy (1xxx)';
      case 'bc1': return 'SegWit (bc1)';
      case 'p2sh-segwit': return 'Wrapped SegWit (3xxx)';
      case 'p2tr': return 'Taproot (bc1p)';
      default: return 'Address';
    }
  };

  // ============================================================================
  // Scan Handlers
  // ============================================================================

  const handleScan = useCallback(async () => {
    const mode = getEffectiveInputMode();
    const currentWif = wifRef.current.trim();
    const currentPhrase = phraseRef.current.trim();
    const currentDescriptor = descriptorRef.current.trim();

    setError('');
    setStep(2);
    setLoading(true);
    setScanProgress('Preparing scan...');

    try {
      if (mode === 'wif') {
        setScanProgress('Scanning for claimable balances...');
        const result = await claimFromWIF(currentWif);
        const scanRes = buildScanResult([result]);
        const agStatus = getAntiGamingStatus(scanRes);
        setAntiGamingWarning(agStatus.warning);
        setAntiGamingBlocked(agStatus.blocked);
        setScanResult(scanRes);
        setStoredCredentials({ type: 'wif', value: currentWif });
        setStep(3);
      } else if (mode === 'phrase') {
        setScanProgress('Scanning addresses (BIP44, BIP84, BIP49, BIP86)...');
        const results = await claimFromMnemonic(currentPhrase, passphrase);
        const scanRes = buildScanResult(results);
        const agStatus = getAntiGamingStatus(scanRes);
        setAntiGamingWarning(agStatus.warning);
        setAntiGamingBlocked(agStatus.blocked);
        setScanResult(scanRes);
        setStoredCredentials({ type: 'phrase', value: currentPhrase });
        setStep(3);
      } else {
        // Descriptor mode — auto-detect WIF
        const wifPattern = /^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/;
        if (wifPattern.test(currentDescriptor)) {
          setScanProgress('Detected WIF key, scanning...');
          const result = await claimFromWIF(currentDescriptor);
          const scanRes = buildScanResult([result]);
          const agStatus = getAntiGamingStatus(scanRes);
          setAntiGamingWarning(agStatus.warning);
          setAntiGamingBlocked(agStatus.blocked);
          setScanResult(scanRes);
          setStoredCredentials({ type: 'wif', value: currentDescriptor });
          setStep(3);
        } else {
          setScanProgress('Parsing descriptors...');
          const scanRes = await scanDescriptorForAirdrop(currentDescriptor);
          const agStatus = getAntiGamingStatus(scanRes);
          setAntiGamingWarning(agStatus.warning);
          setAntiGamingBlocked(agStatus.blocked);
          setScanResult(scanRes);
          setStoredCredentials({ type: 'descriptor', value: currentDescriptor });
          setStep(3);
        }
      }
    } catch (err: any) {
      setError('Failed to scan for airdrop');
      setWifInput('');
      setPhraseInput('');
      setDescriptorInput('');
      setPassphrase('');
      setStep(1);
    } finally {
      setLoading(false);
      setScanProgress('');
    }
  }, [passphrase, walletType, otherInputType]);

  // ============================================================================
  // Import Handler
  // ============================================================================

  const handleImportWallet = useCallback(async () => {
    if (!storedCredentials || !scanResult || scanResult.totalBalance === 0) {
      Alert.alert('Error', 'No wallet to import');
      return;
    }

    if (storedCredentials.type === 'phrase') {
      setWalletPassword('');
      setWalletConfirmPassword('');
      setPasswordError('');
      setShowPasswordStep(true);
    } else if (storedCredentials.type === 'wif') {
      Alert.alert(
        'WIF Import',
        'To import a WIF private key, please use the "Add Wallet" screen and select "Import VOID Wallet".',
        [{ text: 'OK' }],
      );
    } else {
      // Descriptor — can't directly import, guide user
      Alert.alert(
        'Descriptor Wallet',
        'Descriptor wallets cannot be directly imported. To claim your VOID:\n\n' +
        '1. Open Bitcoin Core console\n' +
        '2. Run: dumpprivkey <address>\n' +
        '3. Use the WIF key with "Add Wallet" > "Import VOID"',
        [{ text: 'OK' }],
      );
    }
  }, [storedCredentials, scanResult]);

  const handleClaimWithPassword = useCallback(async () => {
    setPasswordError('');

    if (walletPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      claimPasswordRef.current?.showError();
      setWalletPassword('');
      return;
    }

    if (walletPassword !== walletConfirmPassword) {
      setPasswordError('Passwords do not match');
      claimConfirmPasswordRef.current?.showError();
      setWalletConfirmPassword('');
      return;
    }

    setImporting(true);
    try {
      await saveWallet('Claimed VOID Wallet', storedCredentials!.value, 'void');
      // Clear sensitive data
      setWifInput('');
      setPhraseInput('');
      setDescriptorInput('');
      setPassphrase('');
      setWalletPassword('');
      setWalletConfirmPassword('');
      setStoredCredentials(null);
      setShowPasswordStep(false);
      setStep(4);
    } catch (error: any) {
      Alert.alert('Import Failed', 'Failed to import wallet');
    } finally {
      setImporting(false);
    }
  }, [walletPassword, walletConfirmPassword, storedCredentials, navigation]);

  // ============================================================================
  // Step 0: Wallet Selection
  // ============================================================================

  if (step === 0) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Header */}
        <View style={styles.headerCenter}>
          <Image source={VOID_LOGO} style={styles.headerLogo} resizeMode="contain" />
          <Text style={styles.title}>Claim VOID Airdrop</Text>
          <Text style={styles.subtitle}>
            What wallet software holds your VOID/BTC keys?
          </Text>
        </View>

        {/* Coin Conversion Visual */}
        <View style={styles.conversionCard}>
          <View style={styles.conversionCoin}>
            <Image source={VOID_LOGO} style={styles.coinLogo} resizeMode="contain" />
            <Text style={styles.coinLabel}>VOID</Text>
          </View>
          <Text style={styles.conversionArrow}>{'\u2192'}</Text>
          <View style={styles.conversionCoin}>
            <Image source={VOID_LOGO} style={styles.coinLogo} resizeMode="contain" />
            <Text style={styles.coinLabelAccent}>VOID</Text>
          </View>
        </View>

        {/* Wallet Type Grid */}
        <View style={styles.walletTypeGrid}>
          {WALLET_TYPES.map(wt => (
            <TouchableOpacity
              key={wt.id}
              style={styles.walletTypeCard}
              onPress={() => {
                setWalletType(wt.id);
                setError('');
                setStep(1);
              }}
              activeOpacity={0.7}
              accessibilityLabel={`${wt.label}, ${wt.description}`}
              accessibilityRole="button"
            >
              <Text style={styles.walletTypeIcon}>{wt.icon}</Text>
              <Text style={styles.walletTypeName}>{wt.label}</Text>
              <Text style={styles.walletTypeDesc}>{wt.description}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Back */}
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ============================================================================
  // Step 1: Instructions + Input
  // ============================================================================

  if (step === 1) {
    const config = getWalletConfig();
    const effectiveMode = getEffectiveInputMode();
    const effectiveConfig = getEffectiveConfig();

    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <StepProgress current={1} />

        {/* Header */}
        <View style={styles.headerRow}>
          <Text style={styles.walletIcon}>{config?.icon}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.stepTitle}>{config?.label || 'Import Keys'}</Text>
            <Text style={styles.stepSubtitle}>{config?.description}</Text>
          </View>
        </View>

        {/* Security Notice */}
        <View style={styles.securityNote}>
          <Text style={styles.securityNoteText}>
            Your keys never leave your device
          </Text>
        </View>

        {/* Hardware Wallet Warning */}
        {config?.warning && (
          <View style={styles.warningCard}>
            <Text style={styles.warningText}>{config.warning}</Text>
          </View>
        )}

        {/* Instructions */}
        <View style={styles.instructionCard}>
          {config?.instructions.map((instruction, index) => (
            <View key={index} style={styles.instructionRow}>
              <View style={styles.instructionNumber}>
                <Text style={styles.instructionNumberText}>{index + 1}</Text>
              </View>
              <Text style={styles.instructionText}>{instruction}</Text>
            </View>
          ))}
        </View>

        {/* Error */}
        {error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* Tab Bar for "Other" mode */}
        {walletType === 'other' && (
          <View style={styles.modeSelector}>
            {(['wif', 'phrase', 'descriptor'] as InputMode[]).map(mode => (
              <TouchableOpacity
                key={mode}
                style={[styles.modeButton, otherInputType === mode && styles.modeButtonActive]}
                onPress={() => setOtherInputType(mode)}
              >
                <Text style={[styles.modeButtonText, otherInputType === mode && styles.modeButtonTextActive]}>
                  {mode === 'wif' ? 'WIF' : mode === 'phrase' ? 'Phrase' : 'Descriptor'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Input Field */}
        <View style={styles.inputContainer}>
          <Text style={styles.inputLabel}>{effectiveConfig?.inputLabel}</Text>
          {effectiveMode === 'wif' && (
            <TextInput
              style={styles.input}
              value={wifInput}
              onChangeText={setWifInput}
              placeholder={effectiveConfig?.inputPlaceholder}
              placeholderTextColor={VoidColors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              importantForAutofill="no"
              spellCheck={false}
              secureTextEntry
              maxLength={60}
            />
          )}
          {effectiveMode === 'phrase' && (
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={phraseInput}
              onChangeText={setPhraseInput}
              placeholder={effectiveConfig?.inputPlaceholder}
              placeholderTextColor={VoidColors.textMuted}
              multiline
              numberOfLines={3}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              importantForAutofill="no"
              spellCheck={false}
              maxLength={500}
            />
          )}
          {effectiveMode === 'descriptor' && (
            <TextInput
              style={[styles.input, styles.inputMultiline, { minHeight: 120 }]}
              value={descriptorInput}
              onChangeText={setDescriptorInput}
              placeholder={effectiveConfig?.inputPlaceholder}
              placeholderTextColor={VoidColors.textMuted}
              multiline
              numberOfLines={6}
              maxLength={5000}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              importantForAutofill="no"
              spellCheck={false}
            />
          )}
          <Text style={styles.helperText}>{effectiveConfig?.helperText}</Text>
        </View>

        {/* Passphrase (for mnemonic modes) */}
        {effectiveMode === 'phrase' && (
          <View style={styles.inputContainer}>
            <Text style={styles.inputLabel}>Passphrase (optional)</Text>
            <TextInput
              style={styles.input}
              value={passphrase}
              onChangeText={setPassphrase}
              placeholder="BIP39 passphrase if used..."
              placeholderTextColor={VoidColors.textMuted}
              secureTextEntry
              autoComplete="off"
              importantForAutofill="no"
              spellCheck={false}
              autoCorrect={false}
              maxLength={256}
            />
          </View>
        )}

        {/* Scan Button */}
        <TouchableOpacity
          style={[styles.primaryButton, (!hasInput() || loading) && styles.buttonDisabled]}
          onPress={handleScan}
          disabled={!hasInput() || loading}
        >
          {loading ? (
            <ActivityIndicator color={VoidColors.textPrimary} />
          ) : (
            <Text style={styles.primaryButtonText}>Scan for VOID</Text>
          )}
        </TouchableOpacity>

        {/* Back */}
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => {
            setError('');
            setWifInput('');
            setPhraseInput('');
            setDescriptorInput('');
            setPassphrase('');
            setStep(0);
          }}
        >
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ============================================================================
  // Step 2: Scanning Progress
  // ============================================================================

  if (step === 2) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <StepProgress current={2} />

        <View style={styles.scanContainer}>
          <ActivityIndicator size="large" color={VoidColors.primary} style={styles.scanSpinner} />
          <Text style={styles.scanTitle}>Scanning...</Text>
          <Text style={styles.scanProgressText}>{scanProgress || 'Looking for claimable VOID...'}</Text>
        </View>
      </ScrollView>
    );
  }

  // ============================================================================
  // Step 3: Results & Import
  // ============================================================================

  if (step === 3) {
    const claims = scanResult?.claims ?? [];
    const hasClaims = claims.length > 0;

    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <StepProgress current={3} />

        <Text style={styles.stepTitle}>
          {hasClaims ? 'VOID Found!' : 'No VOID Found'}
        </Text>

        {/* Total Card */}
        {hasClaims && scanResult && (
          <View style={styles.totalCard}>
            <Text style={styles.totalLabel}>Total Claimable</Text>
            <Text style={styles.totalAmount}>
              {formatBalance(scanResult.totalBalance)} VOID
            </Text>
          </View>
        )}

        {/* Anti-gaming Warning */}
        {antiGamingWarning && (
          <View style={[styles.warningCard, antiGamingBlocked && styles.errorCard]}>
            <Text style={[styles.warningText, antiGamingBlocked && styles.errorText]}>
              {antiGamingWarning}
            </Text>
          </View>
        )}

        {/* Per-address Results */}
        {claims.map((claim, index) => {
          const void = claim.voidBalance ?? 0;
          const excess = claim.balance - Math.min(claim.balance, void);
          return (
            <View key={index} style={styles.resultCard}>
              {/* Address type badge */}
              <View style={styles.addressTypeBadge}>
                <Text style={styles.addressTypeBadgeText}>
                  {getAddressTypeLabel(claim.addressType)}
                </Text>
              </View>

              {excess > 0 && void === 0 && (
                <View style={styles.warningBadge}>
                  <Text style={styles.warningBadgeText}>No matching VOID balance</Text>
                </View>
              )}
              {excess > 0 && void > 0 && (
                <View style={styles.warningBadge}>
                  <Text style={styles.warningBadgeText}>
                    {formatBalance(excess)} VOID exceeds VOID balance
                  </Text>
                </View>
              )}

              <View style={styles.resultRow}>
                <Text style={styles.resultLabel}>VOID Address</Text>
                <Text style={styles.resultValue} numberOfLines={1} ellipsizeMode="middle">
                  {claim.address}
                </Text>
              </View>
              <View style={styles.resultRow}>
                <Text style={styles.resultLabel}>VOID Address</Text>
                <Text style={styles.resultValueAccent} numberOfLines={1} ellipsizeMode="middle">
                  {claim.voidAddress}
                </Text>
              </View>
              <View style={styles.resultRow}>
                <Text style={styles.resultLabel}>Balance</Text>
                <Text style={styles.resultBalance}>
                  {formatBalance(claim.balance)} VOID
                </Text>
              </View>
              {void > 0 && (
                <View style={styles.resultRow}>
                  <Text style={styles.resultLabel}>VOID Balance</Text>
                  <Text style={styles.resultValue}>{formatBalance(void)} VOID</Text>
                </View>
              )}
              {claim.derivationPath && (
                <View style={styles.resultRow}>
                  <Text style={styles.resultLabel}>Path</Text>
                  <Text style={styles.resultValueMono}>{claim.derivationPath}</Text>
                </View>
              )}
            </View>
          );
        })}

        {/* No Results */}
        {!hasClaims && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>
              No VOID balance found for this wallet. Make sure you had VOID balance at fork block 53,200.
            </Text>
          </View>
        )}

        {/* Import Button */}
        {hasClaims && !showPasswordStep && (
          <TouchableOpacity
            style={[styles.primaryButton, (importing || antiGamingBlocked) && styles.buttonDisabled]}
            onPress={handleImportWallet}
            disabled={importing || antiGamingBlocked}
          >
            {importing ? (
              <ActivityIndicator color={VoidColors.textPrimary} />
            ) : (
              <Text style={styles.primaryButtonText}>Import Wallet</Text>
            )}
          </TouchableOpacity>
        )}

        {/* Password Step */}
        {showPasswordStep && (
          <View style={styles.passwordStepCard}>
            <Text style={styles.passwordStepTitle}>Set Wallet Password</Text>
            <Text style={styles.passwordStepSubtitle}>
              This password encrypts your recovery phrase.
            </Text>

            <View style={styles.passwordInputGroup}>
              <Text style={styles.inputLabel}>Password (min. 8 characters)</Text>
              <PasswordInput
                ref={claimPasswordRef}
                onSubmit={() => claimConfirmPasswordRef.current?.focus()}
                placeholder="Enter password"
                onChangeText={setWalletPassword}
              />
            </View>

            <View style={styles.passwordInputGroup}>
              <Text style={styles.inputLabel}>Confirm Password</Text>
              <PasswordInput
                ref={claimConfirmPasswordRef}
                onSubmit={handleClaimWithPassword}
                placeholder="Confirm password"
                onChangeText={setWalletConfirmPassword}
              />
            </View>

            {passwordError ? (
              <Text style={styles.passwordError}>{passwordError}</Text>
            ) : null}

            <TouchableOpacity
              style={[styles.primaryButton, importing && styles.buttonDisabled]}
              onPress={handleClaimWithPassword}
              disabled={importing}
            >
              {importing ? (
                <ActivityIndicator color={VoidColors.textPrimary} />
              ) : (
                <Text style={styles.primaryButtonText}>Set Password & Import</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.backButton}
              onPress={() => setShowPasswordStep(false)}
            >
              <Text style={styles.backButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Back */}
        {!showPasswordStep && (
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => {
              setScanResult(null);
              setAntiGamingWarning(null);
              setAntiGamingBlocked(false);
              setStoredCredentials(null);
              setStep(1);
            }}
          >
            <Text style={styles.backButtonText}>Back</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    );
  }

  // ============================================================================
  // Step 4: Success
  // ============================================================================

  if (step === 4) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <StepProgress current={4} />

        <View style={styles.successContainer}>
          <Image source={VOID_LOGO} style={styles.successLogo} resizeMode="contain" />
          <Text style={styles.successTitle}>Wallet Imported!</Text>
          <Text style={styles.successSubtitle}>
            Your VOID wallet has been imported with{' '}
            {formatBalance(scanResult?.totalBalance ?? 0)} VOID
          </Text>
        </View>

        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.primaryButtonText}>Go to Wallet</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return null;
};

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: VoidColors.background,
  },
  content: {
    padding: VOIDSpacing.lg,
    paddingBottom: VOIDSpacing.xxl,
  },

  // Header
  headerCenter: {
    alignItems: 'center',
    marginBottom: VOIDSpacing.lg,
  },
  headerLogo: {
    width: 56,
    height: 56,
    marginBottom: VOIDSpacing.md,
  },
  title: {
    fontSize: VOIDTypography.fontSize.xxl,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
    textAlign: 'center',
    marginBottom: VOIDSpacing.xs,
  },
  subtitle: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: VOIDSpacing.md,
    marginBottom: VOIDSpacing.md,
  },
  walletIcon: {
    fontSize: 32,
    width: 48,
    height: 48,
    textAlign: 'center',
    lineHeight: 48,
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.lg,
    overflow: 'hidden',
  },
  stepTitle: {
    fontSize: VOIDTypography.fontSize.xl,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
    marginBottom: VOIDSpacing.xs,
  },
  stepSubtitle: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
  },

  // Conversion Card
  conversionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.lg,
    padding: VOIDSpacing.lg,
    marginBottom: VOIDSpacing.lg,
  },
  conversionCoin: {
    alignItems: 'center',
  },
  coinLogo: {
    width: 48,
    height: 48,
    marginBottom: VOIDSpacing.sm,
  },
  coinLabel: {
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.voidPrimary,
  },
  coinLabelAccent: {
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.primary,
  },
  conversionArrow: {
    fontSize: 28,
    color: VoidColors.textMuted,
    marginHorizontal: VOIDSpacing.xl,
  },

  // Wallet Type Grid
  walletTypeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: VOIDSpacing.md,
    marginBottom: VOIDSpacing.lg,
  },
  walletTypeCard: {
    width: '47%',
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.lg,
    padding: VOIDSpacing.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: VoidColors.border,
  },
  walletTypeIcon: {
    fontSize: 28,
    marginBottom: VOIDSpacing.sm,
    lineHeight: 36,
  },
  walletTypeName: {
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.semibold,
    color: VoidColors.textPrimary,
    marginBottom: VOIDSpacing.xs,
  },
  walletTypeDesc: {
    fontSize: VOIDTypography.fontSize.xs,
    color: VoidColors.textMuted,
    textAlign: 'center',
  },

  // Step Progress
  stepProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: VOIDSpacing.lg,
  },
  stepDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: VoidColors.border,
    borderWidth: 2,
    borderColor: VoidColors.border,
  },
  stepDotActive: {
    backgroundColor: VoidColors.primary,
    borderColor: VoidColors.primary,
    ...VOIDShadows.glow,
  },
  stepDotCompleted: {
    backgroundColor: VoidColors.primary,
    borderColor: VoidColors.primary,
  },
  stepLine: {
    width: 32,
    height: 2,
    backgroundColor: VoidColors.border,
  },
  stepLineCompleted: {
    backgroundColor: VoidColors.primary,
  },

  // Security Note
  securityNote: {
    backgroundColor: VoidColors.primaryGlow,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.sm,
    marginBottom: VOIDSpacing.md,
    alignItems: 'center',
  },
  securityNoteText: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.primary,
    fontWeight: VOIDTypography.fontWeight.medium,
  },

  // Warning Card
  warningCard: {
    backgroundColor: 'rgba(246, 173, 85, 0.1)',
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.md,
    marginBottom: VOIDSpacing.md,
    borderLeftWidth: 3,
    borderLeftColor: VoidColors.warning,
  },
  warningText: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.warning,
    lineHeight: 20,
  },

  // Instructions
  instructionCard: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.lg,
    padding: VOIDSpacing.lg,
    marginBottom: VOIDSpacing.lg,
  },
  instructionRow: {
    flexDirection: 'row',
    marginBottom: VOIDSpacing.md,
    alignItems: 'flex-start',
  },
  instructionNumber: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: VoidColors.primaryGlow,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: VOIDSpacing.sm,
    marginTop: 1,
  },
  instructionNumberText: {
    fontSize: VOIDTypography.fontSize.xs,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.primary,
  },
  instructionText: {
    flex: 1,
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
    lineHeight: 20,
  },

  // Input
  inputContainer: {
    marginBottom: VOIDSpacing.md,
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
    fontFamily: 'monospace',
  },
  inputMultiline: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  helperText: {
    fontSize: VOIDTypography.fontSize.xs,
    color: VoidColors.textMuted,
    marginTop: VOIDSpacing.xs,
  },

  // Mode Selector
  modeSelector: {
    flexDirection: 'row',
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.xs,
    marginBottom: VOIDSpacing.lg,
  },
  modeButton: {
    flex: 1,
    paddingVertical: VOIDSpacing.sm,
    alignItems: 'center',
    borderRadius: VOIDBorderRadius.sm,
  },
  modeButtonActive: {
    backgroundColor: VoidColors.primary,
  },
  modeButtonText: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
    fontWeight: VOIDTypography.fontWeight.medium,
  },
  modeButtonTextActive: {
    color: VoidColors.textPrimary,
  },

  // Buttons
  primaryButton: {
    backgroundColor: VoidColors.primary,
    borderRadius: VOIDBorderRadius.md,
    paddingVertical: VOIDSpacing.md,
    alignItems: 'center',
    marginTop: VOIDSpacing.md,
    ...VOIDShadows.glow,
  },
  primaryButtonText: {
    color: VoidColors.textPrimary,
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  backButton: {
    paddingVertical: VOIDSpacing.md,
    alignItems: 'center',
    marginTop: VOIDSpacing.sm,
  },
  backButtonText: {
    color: VoidColors.textSecondary,
    fontSize: VOIDTypography.fontSize.base,
  },

  // Error
  errorCard: {
    backgroundColor: 'rgba(252, 129, 129, 0.1)',
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.md,
    marginBottom: VOIDSpacing.md,
    borderLeftWidth: 3,
    borderLeftColor: VoidColors.error,
  },
  errorText: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.error,
    lineHeight: 20,
  },

  // Scanning
  scanContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: VOIDSpacing.xxl,
  },
  scanSpinner: {
    marginBottom: VOIDSpacing.lg,
  },
  scanTitle: {
    fontSize: VOIDTypography.fontSize.xl,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
    marginBottom: VOIDSpacing.sm,
  },
  scanProgressText: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
  },

  // Results
  totalCard: {
    backgroundColor: VoidColors.primaryGlow,
    borderRadius: VOIDBorderRadius.lg,
    padding: VOIDSpacing.lg,
    marginBottom: VOIDSpacing.md,
    borderWidth: 1,
    borderColor: VoidColors.primary,
    alignItems: 'center',
  },
  totalLabel: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
    marginBottom: VOIDSpacing.xs,
  },
  totalAmount: {
    fontSize: VOIDTypography.fontSize.xxl,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.primary,
    fontFamily: 'monospace',
  },
  resultCard: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.md,
    marginBottom: VOIDSpacing.sm,
  },
  addressTypeBadge: {
    backgroundColor: VoidColors.primaryGlow,
    borderRadius: VOIDBorderRadius.sm,
    paddingHorizontal: VOIDSpacing.sm,
    paddingVertical: 2,
    alignSelf: 'flex-start',
    marginBottom: VOIDSpacing.sm,
  },
  addressTypeBadgeText: {
    fontSize: VOIDTypography.fontSize.xs,
    color: VoidColors.primary,
    fontWeight: VOIDTypography.fontWeight.medium,
  },
  warningBadge: {
    backgroundColor: 'rgba(246, 173, 85, 0.15)',
    borderRadius: VOIDBorderRadius.sm,
    paddingHorizontal: VOIDSpacing.sm,
    paddingVertical: VOIDSpacing.xs,
    marginBottom: VOIDSpacing.sm,
  },
  warningBadgeText: {
    color: VoidColors.warning,
    fontSize: VOIDTypography.fontSize.xs,
    fontWeight: VOIDTypography.fontWeight.medium,
  },
  resultRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: VOIDSpacing.xs,
  },
  resultLabel: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
  },
  resultValue: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
    fontFamily: 'monospace',
    maxWidth: '60%',
  },
  resultValueAccent: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.primary,
    fontFamily: 'monospace',
    maxWidth: '60%',
  },
  resultValueMono: {
    fontSize: VOIDTypography.fontSize.xs,
    color: VoidColors.textMuted,
    fontFamily: 'monospace',
    maxWidth: '60%',
  },
  resultBalance: {
    fontSize: VOIDTypography.fontSize.md,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.success,
    fontFamily: 'monospace',
  },
  emptyCard: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.lg,
    alignItems: 'center',
    marginBottom: VOIDSpacing.md,
  },
  emptyText: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
  },

  // Password Step
  passwordStepCard: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.lg,
    padding: VOIDSpacing.lg,
    marginTop: VOIDSpacing.md,
    borderWidth: 1,
    borderColor: VoidColors.primary,
  },
  passwordStepTitle: {
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
    textAlign: 'center',
    marginBottom: VOIDSpacing.xs,
  },
  passwordStepSubtitle: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
    textAlign: 'center',
    marginBottom: VOIDSpacing.lg,
  },
  passwordInputGroup: {
    marginBottom: VOIDSpacing.md,
  },
  passwordError: {
    color: VoidColors.error,
    fontSize: VOIDTypography.fontSize.sm,
    textAlign: 'center',
    marginBottom: VOIDSpacing.md,
  },

  // Success
  successContainer: {
    alignItems: 'center',
    paddingVertical: VOIDSpacing.xxl,
  },
  successLogo: {
    width: 72,
    height: 72,
    marginBottom: VOIDSpacing.lg,
  },
  successTitle: {
    fontSize: VOIDTypography.fontSize.xxl,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.primary,
    marginBottom: VOIDSpacing.sm,
  },
  successSubtitle: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
});

export default ClaimAirdropScreen;
