/**
 * VOID App Password Screen
 * Set/remove an app-level password stored via AsyncStorage
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import ReactNativeBiometrics from 'react-native-biometrics';
import { VoidColors, VOIDSpacing, VOIDTypography, VOIDBorderRadius } from '../../components/VoidTheme';

const APP_PASSWORD_KEY = '@void_app_password';
const BIOMETRIC_ENABLED_KEY = '@void_biometric_enabled';
const AUTO_LOCK_TIMEOUT_KEY = '@void_auto_lock_timeout';

const rnBiometrics = new ReactNativeBiometrics({ allowDeviceCredentials: true });

// --- Biometric helpers ---

export async function isBiometricAvailable(): Promise<{ available: boolean; biometryType?: string }> {
  try {
    const { available, biometryType } = await rnBiometrics.isSensorAvailable();
    return { available, biometryType: biometryType || undefined };
  } catch {
    return { available: false };
  }
}

export async function isBiometricEnabled(): Promise<boolean> {
  const val = await AsyncStorage.getItem(BIOMETRIC_ENABLED_KEY);
  return val === '1';
}

export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(BIOMETRIC_ENABLED_KEY, enabled ? '1' : '');
}

export async function authenticateWithBiometric(): Promise<boolean> {
  try {
    const { available } = await rnBiometrics.isSensorAvailable();
    if (!available) return false;
    const { success } = await rnBiometrics.simplePrompt({ promptMessage: 'Confirm your identity' });
    return success;
  } catch {
    return false;
  }
}

// --- Auto-lock timeout helpers ---
// Values in seconds: 0 = immediate, 30, 60, 300, -1 = never
export async function getAutoLockTimeout(): Promise<number> {
  const val = await AsyncStorage.getItem(AUTO_LOCK_TIMEOUT_KEY);
  if (val === null) return 0; // default: immediate
  return parseInt(val, 10);
}

export async function setAutoLockTimeout(seconds: number): Promise<void> {
  await AsyncStorage.setItem(AUTO_LOCK_TIMEOUT_KEY, String(seconds));
}

export async function getAppPassword(): Promise<string | null> {
  return AsyncStorage.getItem(APP_PASSWORD_KEY);
}

export async function verifyAppPassword(input: string): Promise<boolean> {
  const stored = await AsyncStorage.getItem(APP_PASSWORD_KEY);
  if (!stored) return true; // No password set
  const hash = bytesToHex(sha256(new TextEncoder().encode(input)));
  return hash === stored;
}

interface Props {
  navigation?: any;
}

const VoidAppPassword: React.FC<Props> = ({ navigation }) => {
  const [hasPassword, setHasPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    checkPasswordStatus();
  }, []);

  const checkPasswordStatus = async () => {
    const stored = await AsyncStorage.getItem(APP_PASSWORD_KEY);
    setHasPassword(!!stored);
    setLoading(false);
  };

  const handleSetPassword = async () => {
    if (newPassword.length < 4) {
      Alert.alert('Error', 'Password must be at least 4 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert('Error', 'Passwords do not match');
      return;
    }
    const hash = bytesToHex(sha256(new TextEncoder().encode(newPassword)));
    await AsyncStorage.setItem(APP_PASSWORD_KEY, hash);
    setHasPassword(true);
    setNewPassword('');
    setConfirmPassword('');
    Alert.alert('Success', 'App password has been set. You will be asked for it when opening the app.');
  };

  const handleRemovePassword = async () => {
    const hash = bytesToHex(sha256(new TextEncoder().encode(currentPassword)));
    const stored = await AsyncStorage.getItem(APP_PASSWORD_KEY);
    if (hash !== stored) {
      Alert.alert('Error', 'Current password is incorrect');
      return;
    }
    await AsyncStorage.removeItem(APP_PASSWORD_KEY);
    setHasPassword(false);
    setCurrentPassword('');
    Alert.alert('Success', 'App password has been removed.');
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color={VoidColors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {hasPassword ? (
        <View style={styles.section}>
          <Text style={styles.title}>Remove App Password</Text>
          <Text style={styles.description}>
            Enter your current password to remove it.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Current password"
            placeholderTextColor={VoidColors.textMuted}
            secureTextEntry
            value={currentPassword}
            onChangeText={setCurrentPassword}
            autoFocus
          />
          <TouchableOpacity
            style={[styles.button, styles.dangerButton]}
            onPress={handleRemovePassword}
          >
            <Text style={styles.buttonText}>Remove Password</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.section}>
          <Text style={styles.title}>Set App Password</Text>
          <Text style={styles.description}>
            Protect the app with a password. You will be asked for it each time you open the app.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="New password"
            placeholderTextColor={VoidColors.textMuted}
            secureTextEntry
            value={newPassword}
            onChangeText={setNewPassword}
            autoFocus
          />
          <TextInput
            style={styles.input}
            placeholder="Confirm password"
            placeholderTextColor={VoidColors.textMuted}
            secureTextEntry
            value={confirmPassword}
            onChangeText={setConfirmPassword}
          />
          <TouchableOpacity
            style={styles.button}
            onPress={handleSetPassword}
          >
            <Text style={styles.buttonText}>Set Password</Text>
          </TouchableOpacity>
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
  section: {
    marginTop: VOIDSpacing.xl,
  },
  title: {
    fontSize: VOIDTypography.fontSize.xl,
    fontWeight: VOIDTypography.fontWeight.bold as any,
    color: VoidColors.textPrimary,
    marginBottom: VOIDSpacing.sm,
  },
  description: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
    marginBottom: VOIDSpacing.lg,
    lineHeight: 20,
  },
  input: {
    backgroundColor: VoidColors.backgroundSecondary,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.md,
    fontSize: VOIDTypography.fontSize.md,
    color: VoidColors.textPrimary,
    marginBottom: VOIDSpacing.md,
    borderWidth: 1,
    borderColor: VoidColors.border,
  },
  button: {
    backgroundColor: VoidColors.primary,
    borderRadius: VOIDBorderRadius.md,
    padding: VOIDSpacing.md,
    alignItems: 'center',
    marginTop: VOIDSpacing.sm,
  },
  dangerButton: {
    backgroundColor: VoidColors.error,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: VOIDTypography.fontSize.md,
    fontWeight: VOIDTypography.fontWeight.semibold as any,
  },
});

export default VoidAppPassword;
