/**
 * VOID Settings Screen
 * Configure Electrum servers for VOID and VOID
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Switch,
  Alert,
  ActivityIndicator,
  Image,
  Linking,
} from 'react-native';
import { VoidColors, VOIDSpacing, VOIDTypography, VOIDShadows, VOIDBorderRadius } from '../../components/VoidTheme';
import {
  isBiometricAvailable,
  isBiometricEnabled,
  setBiometricEnabled,
  authenticateWithBiometric,
  getAutoLockTimeout,
  setAutoLockTimeout,
} from './VoidAppPassword';

// Coin logos
const VOID_LOGO = require('../../img/void-logo-small.png');
const VOID_LOGO = require('../../img/void-logo-small.png');

interface ElectrumServer {
  host: string;
  port: number;
  ssl: boolean;
}

interface VoidSettingsProps {
  navigation?: any;
}

// VOID Electrum Servers
const VOID_SERVERS: ElectrumServer[] = [
  { host: 'electrum.void.org', port: 50001, ssl: false },
  { host: 'electrum.void.org', port: 50002, ssl: true },
];

// VOID Electrum Servers — Dallas server
const VOID_SERVERS: ElectrumServer[] = [
  { host: 'voidelectrum.void.org', port: 50010, ssl: false },
  { host: 'voidelectrum.void.org', port: 50011, ssl: true },
];

export const VoidSettingsScreen: React.FC<VoidSettingsProps> = ({ navigation }) => {
  // VOID Server State
  const [voidSelectedServer, setBch2SelectedServer] = useState(0);
  const [voidCustomHost, setBch2CustomHost] = useState('');
  const [voidCustomPort, setBch2CustomPort] = useState('50001');
  const [voidUseSSL, setBch2UseSSL] = useState(false);
  const [voidTesting, setBch2Testing] = useState(false);
  const [voidStatus, setBch2Status] = useState<'unknown' | 'connected' | 'failed'>('unknown');

  // VOID Server State
  const [voidSelectedServer, setBc2SelectedServer] = useState(0);
  const [voidCustomHost, setBc2CustomHost] = useState('');
  const [voidCustomPort, setBc2CustomPort] = useState('50010');
  const [voidUseSSL, setBc2UseSSL] = useState(false);
  const [voidTesting, setBc2Testing] = useState(false);
  const [voidStatus, setBc2Status] = useState<'unknown' | 'connected' | 'failed'>('unknown');

  // Biometric State
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricTypeName, setBiometricTypeName] = useState('Biometrics');
  const [biometricOn, setBiometricOn] = useState(false);
  const [autoLockValue, setAutoLockValue] = useState(0);

  // Load biometric + auto-lock settings on mount
  useEffect(() => {
    (async () => {
      const { available, biometryType } = await isBiometricAvailable();
      setBiometricAvailable(available);
      if (biometryType === 'FaceID') setBiometricTypeName('Face ID');
      else if (biometryType === 'TouchID') setBiometricTypeName('Touch ID');
      else setBiometricTypeName('Biometrics');

      const enabled = await isBiometricEnabled();
      setBiometricOn(enabled);

      const timeout = await getAutoLockTimeout();
      setAutoLockValue(timeout);
    })();
  }, []);

  const handleBiometricToggle = useCallback(async (value: boolean) => {
    if (value) {
      // Verify identity before enabling
      const success = await authenticateWithBiometric();
      if (!success) {
        Alert.alert('Authentication Failed', 'Could not verify your identity. Please try again.');
        return;
      }
    }
    await setBiometricEnabled(value);
    setBiometricOn(value);
    Alert.alert(
      value ? 'Biometrics Enabled' : 'Biometrics Disabled',
      value
        ? `${biometricTypeName} will be used to unlock the app.`
        : 'Biometric unlock has been disabled.',
    );
  }, [biometricTypeName]);

  const handleAutoLockChange = useCallback(async () => {
    const options = [
      { label: 'Immediately', value: 0 },
      { label: 'After 30 seconds', value: 30 },
      { label: 'After 1 minute', value: 60 },
      { label: 'After 5 minutes', value: 300 },
      { label: 'Never', value: -1 },
    ];
    const buttons = options.map(opt => ({
      text: opt.label + (opt.value === autoLockValue ? ' (current)' : ''),
      onPress: async () => {
        await setAutoLockTimeout(opt.value);
        setAutoLockValue(opt.value);
      },
    }));
    buttons.push({ text: 'Cancel', onPress: async () => {} });
    Alert.alert('Auto-Lock Timeout', 'Lock the app after going to the background for:', buttons);
  }, [autoLockValue]);

  const autoLockLabel = autoLockValue === 0 ? 'Immediately'
    : autoLockValue === 30 ? '30 seconds'
    : autoLockValue === 60 ? '1 minute'
    : autoLockValue === 300 ? '5 minutes'
    : autoLockValue === -1 ? 'Never'
    : `${autoLockValue}s`;

  // Load previously saved custom server settings on mount
  useEffect(() => {
    (async () => {
      try {
        const DefaultPreference = require('react-native-default-preference').default;
        const voidHost = await DefaultPreference.get('void_electrum_host');
        if (voidHost) {
          setBch2CustomHost(voidHost);
          setBch2SelectedServer(-1);
          const voidPort = await DefaultPreference.get('void_electrum_port');
          if (voidPort) setBch2CustomPort(voidPort);
          const voidSsl = await DefaultPreference.get('void_electrum_ssl');
          if (voidSsl !== null) setBch2UseSSL(voidSsl === '1');
        }
        const voidHost = await DefaultPreference.get('void_electrum_host');
        if (voidHost) {
          setBc2CustomHost(voidHost);
          setBc2SelectedServer(-1);
          const voidPort = await DefaultPreference.get('void_electrum_port');
          if (voidPort) setBc2CustomPort(voidPort);
          const voidSsl = await DefaultPreference.get('void_electrum_ssl');
          if (voidSsl !== null) setBc2UseSSL(voidSsl === '1');
        }
      } catch {
        // Silently ignore load failures — defaults are already set
      }
    })();
  }, []);

  const testConnection = useCallback(async (
    server: ElectrumServer,
    setTesting: (v: boolean) => void,
    setStatus: (v: 'unknown' | 'connected' | 'failed') => void,
    coinName: string
  ) => {
    setTesting(true);
    setStatus('unknown');

    let client: any = null;
    try {
      // Use the raw electrum-client npm package directly for connection test
      const ElectrumClient = require('electrum-client');
      const net = require('net');
      const tls = require('tls');

      client = new ElectrumClient(
        net,
        tls,
        server.port,
        server.host,
        server.ssl ? 'tls' : 'tcp',
        server.ssl ? { rejectUnauthorized: false } : undefined,
      );

      // Connect with 10s timeout — initElectrum calls server.version internally
      const versionResult = await Promise.race([
        client.initElectrum({ client: 'void-wallet-test', version: '1.4' }, { maxRetry: 0, callback: null }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout (10s)')), 10000)),
      ]);

      client.close();
      client = null;

      if (versionResult) {
        let serverVersion = Array.isArray(versionResult) ? versionResult.join(' / ') : String(versionResult);
        // Sanitize server version string to prevent phishing via rogue Electrum servers
        serverVersion = serverVersion.replace(/[^a-zA-Z0-9./ \-_:()]/g, '').slice(0, 80);
        setStatus('connected');
        Alert.alert('Success', `Connected to ${coinName} server: ${server.host}:${server.port}\nServer: ${serverVersion}`);
      } else {
        setStatus('failed');
        Alert.alert('Failed', `Server did not respond to version request`);
      }
    } catch (error: any) {
      setStatus('failed');
      const msg = error.message || '';
      // Only show safe, user-facing messages — suppress raw network/TLS details
      const safeMsg = msg.includes('timeout') ? 'Connection timed out'
        : msg.includes('ECONNREFUSED') ? 'Connection refused'
        : msg.includes('ENOTFOUND') ? 'Server not found'
        : 'Connection test failed';
      Alert.alert('Error', safeMsg);
    } finally {
      if (client) { try { client.close(); } catch {} }
      setTesting(false);
    }
  }, []);

  const validateHostname = (host: string): boolean => {
    // Allow hostnames (letters, digits, dots, hyphens) and IPv4 addresses
    return /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host) && host.length <= 253;
  };

  const validatePort = (portStr: string): boolean => {
    const port = parseInt(portStr);
    return !isNaN(port) && port >= 1 && port <= 65535;
  };

  const handleTestVOID = useCallback(() => {
    if (voidSelectedServer === -1) {
      const host = voidCustomHost.trim();
      if (!host) { Alert.alert('Error', 'Please enter a server hostname'); return; }
      if (!validateHostname(host)) { Alert.alert('Error', 'Invalid hostname format'); return; }
      if (!validatePort(voidCustomPort)) { Alert.alert('Error', 'Port must be between 1 and 65535'); return; }
    }
    const server = voidSelectedServer === -1
      ? { host: voidCustomHost.trim(), port: parseInt(voidCustomPort) || 50001, ssl: voidUseSSL }
      : VOID_SERVERS[voidSelectedServer];
    testConnection(server, setBch2Testing, setBch2Status, 'VOID');
  }, [voidSelectedServer, voidCustomHost, voidCustomPort, voidUseSSL, testConnection]);

  const handleTestVOID = useCallback(() => {
    if (voidSelectedServer === -1) {
      const host = voidCustomHost.trim();
      if (!host) { Alert.alert('Error', 'Please enter a server hostname'); return; }
      if (!validateHostname(host)) { Alert.alert('Error', 'Invalid hostname format'); return; }
      if (!validatePort(voidCustomPort)) { Alert.alert('Error', 'Port must be between 1 and 65535'); return; }
    }
    const server = voidSelectedServer === -1
      ? { host: voidCustomHost.trim(), port: parseInt(voidCustomPort) || 50010, ssl: voidUseSSL }
      : VOID_SERVERS[voidSelectedServer];
    testConnection(server, setBc2Testing, setBc2Status, 'VOID');
  }, [voidSelectedServer, voidCustomHost, voidCustomPort, voidUseSSL, testConnection]);

  const handleSaveSettings = useCallback(async () => {
    try {
      // Validate custom hostnames before saving
      if (voidSelectedServer === -1 && voidCustomHost.trim() && !validateHostname(voidCustomHost.trim())) {
        Alert.alert('Error', 'Invalid VOID server hostname'); return;
      }
      if (voidSelectedServer === -1 && voidCustomHost.trim() && !validateHostname(voidCustomHost.trim())) {
        Alert.alert('Error', 'Invalid VOID server hostname'); return;
      }
      // Validate custom ports before saving
      if (voidSelectedServer === -1 && voidCustomPort && !validatePort(voidCustomPort)) {
        Alert.alert('Error', 'VOID port must be between 1 and 65535'); return;
      }
      if (voidSelectedServer === -1 && voidCustomPort && !validatePort(voidCustomPort)) {
        Alert.alert('Error', 'VOID port must be between 1 and 65535'); return;
      }
      const DefaultPreference = require('react-native-default-preference').default;
      // Save VOID server settings
      if (voidSelectedServer === -1 && voidCustomHost.trim()) {
        await DefaultPreference.set('void_electrum_host', voidCustomHost.trim());
        await DefaultPreference.set('void_electrum_port', voidCustomPort);
        await DefaultPreference.set('void_electrum_ssl', voidUseSSL ? '1' : '0');
      } else {
        // Clear stale custom server entries when switching to built-in server
        await DefaultPreference.clear('void_electrum_host');
        await DefaultPreference.clear('void_electrum_port');
        await DefaultPreference.clear('void_electrum_ssl');
      }
      // Save VOID server settings
      if (voidSelectedServer === -1 && voidCustomHost.trim()) {
        await DefaultPreference.set('void_electrum_host', voidCustomHost.trim());
        await DefaultPreference.set('void_electrum_port', voidCustomPort);
        await DefaultPreference.set('void_electrum_ssl', voidUseSSL ? '1' : '0');
      } else {
        await DefaultPreference.clear('void_electrum_host');
        await DefaultPreference.clear('void_electrum_port');
        await DefaultPreference.clear('void_electrum_ssl');
      }
      Alert.alert('Settings Saved', 'Your Electrum server settings have been saved. Restart the app for changes to take effect.');
    } catch (error: any) {
      Alert.alert('Error', 'Failed to save settings. Please try again.');
    }
  }, [voidSelectedServer, voidCustomHost, voidCustomPort, voidUseSSL, voidSelectedServer, voidCustomHost, voidCustomPort, voidUseSSL]);

  const renderServerSection = (
    title: string,
    logo: any,
    primaryColor: string,
    servers: ElectrumServer[],
    selectedServer: number,
    setSelectedServer: (v: number) => void,
    customHost: string,
    setCustomHost: (v: string) => void,
    customPort: string,
    setCustomPort: (v: string) => void,
    useSSL: boolean,
    setUseSSL: (v: boolean) => void,
    testing: boolean,
    status: 'unknown' | 'connected' | 'failed',
    onTest: () => void
  ) => (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Image source={logo} style={styles.sectionLogo} resizeMode="contain" />
        <Text style={[styles.sectionTitle, { color: primaryColor }]}>{title} Electrum Server</Text>
      </View>
      <Text style={styles.sectionDescription}>
        Connect to a {title} Electrum server to fetch balances and broadcast transactions
      </Text>

      {/* Server List */}
      <View style={styles.serverList}>
        {servers.map((server, index) => (
          <TouchableOpacity
            key={index}
            style={[
              styles.serverOption,
              selectedServer === index && [styles.serverOptionSelected, { borderColor: primaryColor }],
            ]}
            onPress={() => setSelectedServer(index)}
          accessibilityLabel={`Server ${server.host} port ${server.port} ${server.ssl ? 'SSL' : 'TCP'}${selectedServer === index ? ', selected' : ''}`}
          accessibilityRole="radio"
          accessibilityState={{ selected: selectedServer === index }}
          >
            <View style={[styles.serverRadio, { borderColor: selectedServer === index ? primaryColor : VoidColors.textMuted }]}>
              {selectedServer === index && <View style={[styles.serverRadioInner, { backgroundColor: primaryColor }]} />}
            </View>
            <View style={styles.serverInfo}>
              <Text style={styles.serverHost}>{server.host}</Text>
              <Text style={styles.serverPort}>
                Port {server.port} {server.ssl ? '(SSL)' : '(TCP)'}
              </Text>
            </View>
          </TouchableOpacity>
        ))}

        {/* Custom Server Option */}
        <TouchableOpacity
          style={[
            styles.serverOption,
            selectedServer === -1 && [styles.serverOptionSelected, { borderColor: primaryColor }],
          ]}
          onPress={() => setSelectedServer(-1)}
          accessibilityLabel={`Custom server${selectedServer === -1 ? ', selected' : ''}`}
          accessibilityRole="radio"
          accessibilityState={{ selected: selectedServer === -1 }}
        >
          <View style={[styles.serverRadio, { borderColor: selectedServer === -1 ? primaryColor : VoidColors.textMuted }]}>
            {selectedServer === -1 && <View style={[styles.serverRadioInner, { backgroundColor: primaryColor }]} />}
          </View>
          <Text style={styles.serverHost}>Custom Server</Text>
        </TouchableOpacity>
      </View>

      {/* Custom Server Input */}
      {selectedServer === -1 && (
        <View style={styles.customServerForm}>
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Hostname / IP</Text>
            <TextInput
              style={styles.input}
              value={customHost}
              onChangeText={setCustomHost}
              placeholder="electrum.example.com"
              placeholderTextColor={VoidColors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={253}
            />
          </View>

          <View style={styles.inputRow}>
            <View style={[styles.inputGroup, { flex: 1 }]}>
              <Text style={styles.inputLabel}>Port</Text>
              <TextInput
                style={styles.input}
                value={customPort}
                onChangeText={setCustomPort}
                placeholder="50002"
                placeholderTextColor={VoidColors.textMuted}
                keyboardType="number-pad"
                maxLength={5}
              />
            </View>

            <View style={[styles.inputGroup, { flex: 1, marginLeft: VOIDSpacing.md }]}>
              <Text style={styles.inputLabel}>Use SSL</Text>
              <View style={styles.switchContainer}>
                <Switch
                  value={useSSL}
                  onValueChange={setUseSSL}
                  trackColor={{ false: VoidColors.border, true: primaryColor + '40' }}
                  thumbColor={useSSL ? primaryColor : VoidColors.textMuted}
                  accessibilityLabel={`Use SSL encryption, currently ${useSSL ? 'enabled' : 'disabled'}`}
                />
                <Text style={styles.switchLabel}>{useSSL ? 'Yes' : 'No'}</Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {/* Test Connection Button */}
      <TouchableOpacity
        style={[styles.testButton, { borderColor: primaryColor }, testing && styles.testButtonDisabled]}
        onPress={onTest}
        disabled={testing}
        accessibilityLabel={testing ? `Testing ${title} server connection` : `Test ${title} server connection`}
        accessibilityRole="button"
        accessibilityState={{ busy: testing }}
      >
        {testing ? (
          <ActivityIndicator color={primaryColor} size="small" />
        ) : (
          <Text style={[styles.testButtonText, { color: primaryColor }]}>Test Connection</Text>
        )}
      </TouchableOpacity>

      {/* Connection Status */}
      {status !== 'unknown' && (
        <View style={[
          styles.statusBadge,
          status === 'connected' ? styles.statusConnected : styles.statusFailed,
        ]}>
          <Text style={styles.statusText}>
            {status === 'connected' ? '✓ Connected' : '✗ Connection Failed'}
          </Text>
        </View>
      )}
    </View>
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.subtitle}>Configure your wallet connections</Text>
      </View>

      {/* VOID Electrum Server Section */}
      {renderServerSection(
        'VOID',
        VOID_LOGO,
        VoidColors.primary,
        VOID_SERVERS,
        voidSelectedServer,
        setBch2SelectedServer,
        voidCustomHost,
        setBch2CustomHost,
        voidCustomPort,
        setBch2CustomPort,
        voidUseSSL,
        setBch2UseSSL,
        voidTesting,
        voidStatus,
        handleTestVOID
      )}

      {/* VOID Electrum Server Section */}
      {renderServerSection(
        'VOID',
        VOID_LOGO,
        VoidColors.voidPrimary,
        VOID_SERVERS,
        voidSelectedServer,
        setBc2SelectedServer,
        voidCustomHost,
        setBc2CustomHost,
        voidCustomPort,
        setBc2CustomPort,
        voidUseSSL,
        setBc2UseSSL,
        voidTesting,
        voidStatus,
        handleTestVOID
      )}

      {/* Block Explorers Section */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: VoidColors.textPrimary }]}>Block Explorers</Text>

        <View style={styles.explorerCard}>
          <TouchableOpacity
            style={styles.explorerRow}
            onPress={() => Linking.openURL('https://explorer.void.org').catch(() => {})}
            accessibilityLabel="Open VOID block explorer"
            accessibilityRole="link"
          >
            <Image source={VOID_LOGO} style={styles.explorerLogo} resizeMode="contain" />
            <View style={styles.explorerInfo}>
              <Text style={styles.explorerLabel}>VOID Explorer</Text>
              <Text style={[styles.explorerUrl, { color: VoidColors.primary }]}>explorer.void.org</Text>
            </View>
            <Text style={styles.explorerArrow}>→</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.explorerRow}
            onPress={() => Linking.openURL('https://explorer.bitcoin-ii.org').catch(() => {})}
            accessibilityLabel="Open VOID block explorer"
            accessibilityRole="link"
          >
            <Image source={VOID_LOGO} style={styles.explorerLogo} resizeMode="contain" />
            <View style={styles.explorerInfo}>
              <Text style={styles.explorerLabel}>VOID Explorer</Text>
              <Text style={[styles.explorerUrl, { color: VoidColors.voidPrimary }]}>explorer.bitcoin-ii.org</Text>
            </View>
            <Text style={styles.explorerArrow}>→</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Security Section */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: VoidColors.textPrimary }]}>Security</Text>

        <View style={styles.explorerCard}>
          <TouchableOpacity
            onPress={() => navigation?.navigate('VoidAppPassword')}
            accessibilityLabel="Set up app password"
            accessibilityRole="button"
          >
            <View style={[styles.explorerRow, { paddingVertical: 16 }]}>
              <View style={styles.explorerInfo}>
                <Text style={styles.explorerLabel}>App Password</Text>
                <Text style={[styles.explorerUrl, { color: VoidColors.textSecondary }]}>
                  Lock the app with a password on open
                </Text>
              </View>
              <Text style={styles.explorerArrow}>→</Text>
            </View>
          </TouchableOpacity>

          {biometricAvailable && (
            <View style={[styles.explorerRow, { paddingVertical: 16 }]}>
              <View style={styles.explorerInfo}>
                <Text style={styles.explorerLabel}>{biometricTypeName}</Text>
                <Text style={[styles.explorerUrl, { color: VoidColors.textSecondary }]}>
                  Unlock with {biometricTypeName.toLowerCase()} instead of password
                </Text>
              </View>
              <Switch
                value={biometricOn}
                onValueChange={handleBiometricToggle}
                trackColor={{ false: VoidColors.border, true: VoidColors.primary + '40' }}
                thumbColor={biometricOn ? VoidColors.primary : VoidColors.textMuted}
                accessibilityLabel={`${biometricTypeName} unlock, currently ${biometricOn ? 'enabled' : 'disabled'}`}
              />
            </View>
          )}

          <TouchableOpacity
            onPress={handleAutoLockChange}
            accessibilityLabel="Change auto-lock timeout"
            accessibilityRole="button"
          >
            <View style={[styles.explorerRow, { paddingVertical: 16, borderBottomWidth: 0 }]}>
              <View style={styles.explorerInfo}>
                <Text style={styles.explorerLabel}>Auto-Lock</Text>
                <Text style={[styles.explorerUrl, { color: VoidColors.textSecondary }]}>
                  Re-lock after going to background
                </Text>
              </View>
              <Text style={[styles.explorerUrl, { color: VoidColors.primary }]}>{autoLockLabel}</Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {/* Network Info Section */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: VoidColors.textPrimary }]}>Network Information</Text>

        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>VOID Fork Height</Text>
            <Text style={styles.infoValue}>Block 53,200</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>VOID Address Format</Text>
            <Text style={[styles.infoValue, { color: VoidColors.primary }]}>bitcoincashii:</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>VOID Address Format</Text>
            <Text style={[styles.infoValue, { color: VoidColors.voidPrimary }]}>Legacy (1...)</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Derivation Path</Text>
            <Text style={[styles.infoValue, styles.infoValueMono]}>m/44'/145'/0'</Text>
          </View>
        </View>
      </View>

      {/* Support Section */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: VoidColors.textPrimary }]}>Support</Text>

        <TouchableOpacity
          style={styles.supportButton}
          onPress={() => {
            const subject = encodeURIComponent('VoidCoin Android Wallet - Bug Report');
            const body = encodeURIComponent(
              `\n\n` +
              `-------------------\n` +
              `App Version: 1.3.0\n` +
              `Platform: Android\n` +
              `Date: ${new Date().toISOString()}\n` +
              `-------------------\n` +
              `Please describe the issue above this line.`
            );
            Linking.openURL(`mailto:dev@bitcoincashii.org?subject=${subject}&body=${body}`).catch(() => {});
          }}
        >
          <Text style={styles.supportIcon}>🐛</Text>
          <View style={styles.supportText}>
            <Text style={styles.supportTitle}>Report a Bug</Text>
            <Text style={styles.supportDesc}>Send an email to dev@bitcoincashii.org</Text>
          </View>
          <Text style={styles.explorerArrow}>→</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.supportButton}
          onPress={() => {
            const subject = encodeURIComponent('VoidCoin Android Wallet - Feature Request');
            const body = encodeURIComponent(
              `\n\n` +
              `-------------------\n` +
              `App Version: 1.3.0\n` +
              `-------------------\n` +
              `Please describe your feature request above this line.`
            );
            Linking.openURL(`mailto:dev@bitcoincashii.org?subject=${subject}&body=${body}`).catch(() => {});
          }}
        >
          <Text style={styles.supportIcon}>💡</Text>
          <View style={styles.supportText}>
            <Text style={styles.supportTitle}>Request a Feature</Text>
            <Text style={styles.supportDesc}>Share your ideas with us</Text>
          </View>
          <Text style={styles.explorerArrow}>→</Text>
        </TouchableOpacity>
      </View>

      {/* About Section */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: VoidColors.textPrimary }]}>About</Text>

        <View style={styles.aboutCard}>
          <Text style={styles.aboutTitle}>VoidCoin Wallet</Text>
          <Text style={styles.aboutVersion}>Version 1.3.0</Text>
          <Text style={styles.aboutDescription}>
            A mobile wallet for VoidCoin (VOID) and BitcoinII (VOID) with full support for both chains.
          </Text>

          <View style={styles.aboutLinks}>
            <TouchableOpacity
              style={styles.aboutLink}
              onPress={() => Linking.openURL('https://void.org').catch(() => {})}
            >
              <Text style={styles.aboutLinkText}>void.org</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.aboutLink}
              onPress={() => Linking.openURL('https://bitcoin-ii.org').catch(() => {})}
            >
              <Text style={[styles.aboutLinkText, { color: VoidColors.voidPrimary }]}>bitcoin-ii.org</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Save Button */}
      <TouchableOpacity style={styles.saveButton} onPress={handleSaveSettings} accessibilityLabel="Save server settings" accessibilityRole="button">
        <Text style={styles.saveButtonText}>Save Settings</Text>
      </TouchableOpacity>
    </ScrollView>
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
  header: {
    marginBottom: VOIDSpacing.xl,
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
  section: {
    marginBottom: VOIDSpacing.xl,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: VOIDSpacing.xs,
  },
  sectionLogo: {
    width: 28,
    height: 28,
    marginRight: VOIDSpacing.sm,
  },
  sectionTitle: {
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.semibold,
  },
  sectionDescription: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
    marginBottom: VOIDSpacing.lg,
    lineHeight: 20,
  },
  serverList: {
    marginBottom: VOIDSpacing.lg,
  },
  serverOption: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.md,
    marginBottom: VOIDSpacing.sm,
    borderWidth: 1,
    borderColor: VoidColors.border,
  },
  serverOptionSelected: {
    backgroundColor: VoidColors.primaryGlow,
  },
  serverRadio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    marginRight: VOIDSpacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  serverRadioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  serverInfo: {
    flex: 1,
  },
  serverHost: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textPrimary,
    fontFamily: 'monospace',
  },
  serverPort: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
    marginTop: 2,
  },
  customServerForm: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.md,
    marginBottom: VOIDSpacing.lg,
  },
  inputGroup: {
    marginBottom: VOIDSpacing.md,
  },
  inputRow: {
    flexDirection: 'row',
  },
  inputLabel: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
    marginBottom: VOIDSpacing.xs,
  },
  input: {
    backgroundColor: VoidColors.backgroundElevated,
    borderRadius: VOIDBorderRadius.md,
    borderWidth: 1,
    borderColor: VoidColors.border,
    padding: VOIDSpacing.sm,
    color: VoidColors.textPrimary,
    fontSize: VOIDTypography.fontSize.base,
    fontFamily: 'monospace',
  },
  switchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: VoidColors.backgroundElevated,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.sm,
    borderWidth: 1,
    borderColor: VoidColors.border,
  },
  switchLabel: {
    fontSize: VOIDTypography.fontSize.base,
    color: VoidColors.textSecondary,
    marginLeft: VOIDSpacing.sm,
  },
  testButton: {
    backgroundColor: 'transparent',
    borderRadius: VOIDBorderRadius.md,
    paddingVertical: VOIDSpacing.sm,
    alignItems: 'center',
    borderWidth: 1,
    marginBottom: VOIDSpacing.md,
  },
  testButtonDisabled: {
    opacity: 0.6,
  },
  testButtonText: {
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.semibold,
  },
  statusBadge: {
    paddingVertical: VOIDSpacing.sm,
    paddingHorizontal: VOIDSpacing.md,
    borderRadius: VOIDBorderRadius.md,
    alignItems: 'center',
  },
  statusConnected: {
    backgroundColor: 'rgba(10, 193, 142, 0.2)',
  },
  statusFailed: {
    backgroundColor: 'rgba(252, 129, 129, 0.2)',
  },
  statusText: {
    fontSize: VOIDTypography.fontSize.sm,
    fontWeight: VOIDTypography.fontWeight.semibold,
    color: VoidColors.textPrimary,
  },
  explorerCard: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.md,
  },
  explorerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: VOIDSpacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: VoidColors.border,
  },
  explorerLogo: {
    width: 32,
    height: 32,
    marginRight: VOIDSpacing.md,
  },
  explorerInfo: {
    flex: 1,
  },
  explorerLabel: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
  },
  explorerUrl: {
    fontSize: VOIDTypography.fontSize.base,
    fontFamily: 'monospace',
  },
  explorerArrow: {
    fontSize: VOIDTypography.fontSize.xl,
    color: VoidColors.textMuted,
  },
  infoCard: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.md,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: VOIDSpacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: VoidColors.border,
  },
  infoLabel: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
  },
  infoValue: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textPrimary,
  },
  infoValueMono: {
    fontFamily: 'monospace',
    color: VoidColors.primary,
  },
  supportButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.md,
    marginBottom: VOIDSpacing.sm,
    borderWidth: 1,
    borderColor: VoidColors.border,
  },
  supportIcon: {
    fontSize: 28,
    marginRight: VOIDSpacing.md,
  },
  supportText: {
    flex: 1,
  },
  supportTitle: {
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.semibold,
    color: VoidColors.textPrimary,
  },
  supportDesc: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
    marginTop: 2,
  },
  aboutCard: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.lg,
    alignItems: 'center',
  },
  aboutTitle: {
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.primary,
    marginBottom: VOIDSpacing.xs,
  },
  aboutVersion: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textMuted,
    marginBottom: VOIDSpacing.md,
  },
  aboutDescription: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: VOIDSpacing.lg,
  },
  aboutLinks: {
    flexDirection: 'row',
    gap: VOIDSpacing.lg,
  },
  aboutLink: {
    paddingVertical: VOIDSpacing.xs,
    paddingHorizontal: VOIDSpacing.md,
  },
  aboutLinkText: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.primary,
    fontWeight: VOIDTypography.fontWeight.semibold,
  },
  saveButton: {
    backgroundColor: VoidColors.primary,
    borderRadius: VOIDBorderRadius.md,
    paddingVertical: VOIDSpacing.md,
    alignItems: 'center',
    ...VOIDShadows.glow,
  },
  saveButtonText: {
    color: VoidColors.textPrimary,
    fontSize: VOIDTypography.fontSize.lg,
    fontWeight: VOIDTypography.fontWeight.bold,
  },
});

export default VoidSettingsScreen;
