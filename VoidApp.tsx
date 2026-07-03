/**
 * VOID App Entry Point
 * Main app with VOID navigation
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { StatusBar, View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, AppState, Alert } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { VoidNavigator } from './navigation/VoidNavigator';
import { VoidColors } from './components/VoidTheme';
import VoidElectrum from './blue_modules/VoidElectrum';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getAppPassword,
  verifyAppPassword,
  isBiometricAvailable,
  isBiometricEnabled,
  authenticateWithBiometric,
  getAutoLockTimeout,
} from './screen/void/VoidAppPassword';

const MAX_UNLOCK_ATTEMPTS = 10;

// VOID Dark Theme
const VoidTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: VoidColors.primary,
    background: VoidColors.background,
    card: VoidColors.backgroundCard,
    text: VoidColors.textPrimary,
    border: VoidColors.border,
    notification: VoidColors.primary,
  },
};

const VoidApp: React.FC = () => {
  const [isConnecting, setIsConnecting] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'offline' | 'connecting'>('connecting');
  const [locked, setLocked] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [biometricType, setBiometricType] = useState<string | undefined>(undefined);
  const [biometricReady, setBiometricReady] = useState(false);
  const [unlockAttempts, setUnlockAttempts] = useState(0);

  // Background re-lock refs (avoid stale closures)
  const appState = useRef(AppState.currentState);
  const backgroundTimestamp = useRef<number | null>(null);
  const hasUnlockedOnce = useRef(false);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  useEffect(() => {
    initializeApp();
  }, []);

  // Auto-lock on background — single listener, uses refs to avoid stale state
  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextAppState) => {
      try {
        if (appState.current === 'active' && (nextAppState === 'inactive' || nextAppState === 'background')) {
          backgroundTimestamp.current = Date.now();
        } else if (appState.current !== 'active' && nextAppState === 'active') {
          if (hasUnlockedOnce.current && !lockedRef.current) {
            const hasPassword = await getAppPassword();
            const bioEnabled = await isBiometricEnabled();
            if (hasPassword || bioEnabled) {
              const timeout = await getAutoLockTimeout();
              if (timeout !== -1) {
                const elapsed = backgroundTimestamp.current
                  ? (Date.now() - backgroundTimestamp.current) / 1000
                  : Infinity;
                if (elapsed >= timeout) {
                  setLocked(true);
                  setPasswordInput('');
                  setPasswordError('');
                  setUnlockAttempts(0);
                  if (bioEnabled) {
                    setTimeout(() => tryBiometricUnlock(), 300);
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.log('Auto-lock error:', e);
      }
      appState.current = nextAppState;
    });
    return () => subscription.remove();
  }, []);

  const initializeApp = async () => {
    setIsConnecting(true);
    try {
      const hasPassword = await getAppPassword();
      const bioEnabled = await isBiometricEnabled();
      const { available, biometryType } = await isBiometricAvailable();

      if (available && bioEnabled) {
        setBiometricType(biometryType);
        setBiometricReady(true);
      }

      if (hasPassword || bioEnabled) {
        setLocked(true);
        // Auto-trigger biometric if available
        if (available && bioEnabled) {
          setTimeout(() => tryBiometricUnlock(), 400);
        }
      }
      setConnectionStatus('connected');
    } catch (error) {
      console.log('Initial connection attempt failed, will retry on demand');
      setConnectionStatus('offline');
    } finally {
      setIsConnecting(false);
    }
  };

  const tryBiometricUnlock = useCallback(async () => {
    const success = await authenticateWithBiometric();
    if (success) {
      setLocked(false);
      setPasswordInput('');
      setPasswordError('');
      setUnlockAttempts(0);
      hasUnlockedOnce.current = true;
    }
  }, []);

  const handleUnlock = async () => {
    const ok = await verifyAppPassword(passwordInput);
    if (ok) {
      setLocked(false);
      setPasswordInput('');
      setPasswordError('');
      setUnlockAttempts(0);
      hasUnlockedOnce.current = true;
    } else {
      const attempts = unlockAttempts + 1;
      setUnlockAttempts(attempts);
      setPasswordError(`Incorrect password (${attempts}/${MAX_UNLOCK_ATTEMPTS})`);
      setPasswordInput('');
      if (attempts >= MAX_UNLOCK_ATTEMPTS) {
        Alert.alert(
          'Too Many Attempts',
          'You have entered the wrong password 10 times. For security, you can wipe app data and start fresh.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Wipe Data',
              style: 'destructive',
              onPress: async () => {
                try {
                  await AsyncStorage.clear();
                  setLocked(false);
                  setUnlockAttempts(0);
                  setPasswordError('');
                  hasUnlockedOnce.current = false;
                  Alert.alert('Data Wiped', 'All wallet data has been removed. Please restart the app.');
                } catch (e) {
                  Alert.alert('Error', 'Failed to wipe data.');
                }
              },
            },
          ],
        );
      }
    }
  };

  if (isConnecting) {
    return (
      <View style={styles.loadingContainer}>
        <StatusBar barStyle="light-content" backgroundColor={VoidColors.background} />
        <View style={styles.logoContainer}>
          <Text style={styles.logoText}>VOID</Text>
          <Text style={styles.logoSubtext}>Wallet</Text>
        </View>
        <ActivityIndicator size="large" color={VoidColors.primary} style={styles.spinner} />
        <Text style={styles.loadingText}>Initializing...</Text>
      </View>
    );
  }

  if (locked) {
    const hasPasswordSet = unlockAttempts > 0 || passwordInput.length > 0 || !biometricReady;
    return (
      <View style={styles.loadingContainer}>
        <StatusBar barStyle="light-content" backgroundColor={VoidColors.background} />
        <View style={styles.logoContainer}>
          <Text style={styles.logoText}>VOID</Text>
          <Text style={styles.logoSubtext}>Wallet</Text>
        </View>

        {biometricReady && (
          <TouchableOpacity style={styles.biometricButton} onPress={tryBiometricUnlock}>
            <Text style={styles.biometricIcon}>
              {biometricType === 'FaceID' ? '🔓' : '🔓'}
            </Text>
            <Text style={styles.biometricButtonText}>
              Unlock with {biometricType === 'FaceID' ? 'Face' : biometricType === 'TouchID' ? 'Touch ID' : 'Biometrics'}
            </Text>
          </TouchableOpacity>
        )}

        {/* Show password input if password is set */}
        {(hasPasswordSet || !biometricReady) && (
          <>
            {biometricReady && (
              <Text style={styles.orText}>or enter password</Text>
            )}
            <TextInput
              style={styles.passwordInput}
              placeholder="Enter password"
              placeholderTextColor={VoidColors.textMuted}
              secureTextEntry
              value={passwordInput}
              onChangeText={(t) => { setPasswordInput(t); setPasswordError(''); }}
              onSubmitEditing={handleUnlock}
              autoFocus={!biometricReady}
            />
            {passwordError ? <Text style={styles.errorText}>{passwordError}</Text> : null}
            <TouchableOpacity style={styles.unlockButton} onPress={handleUnlock}>
              <Text style={styles.unlockButtonText}>Unlock</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={VoidColors.background} />
      <NavigationContainer theme={VoidTheme}>
        <VoidNavigator />
      </NavigationContainer>
    </SafeAreaProvider>
  );
};

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: VoidColors.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 48,
  },
  logoText: {
    fontSize: 48,
    fontWeight: 'bold',
    color: VoidColors.primary,
  },
  logoSubtext: {
    fontSize: 24,
    color: VoidColors.textSecondary,
    marginLeft: 8,
  },
  spinner: {
    marginBottom: 16,
  },
  loadingText: {
    fontSize: 14,
    color: VoidColors.textMuted,
  },
  biometricButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: VoidColors.primaryGlow,
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 32,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: VoidColors.primary,
  },
  biometricIcon: {
    fontSize: 24,
    marginRight: 12,
  },
  biometricButtonText: {
    color: VoidColors.primary,
    fontSize: 16,
    fontWeight: '600',
  },
  orText: {
    color: VoidColors.textMuted,
    fontSize: 14,
    marginBottom: 12,
    marginTop: 4,
  },
  passwordInput: {
    width: '80%',
    backgroundColor: VoidColors.backgroundSecondary,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    color: VoidColors.textPrimary,
    borderWidth: 1,
    borderColor: VoidColors.border,
    marginBottom: 12,
    textAlign: 'center',
  },
  errorText: {
    color: VoidColors.error,
    fontSize: 14,
    marginBottom: 12,
  },
  unlockButton: {
    backgroundColor: VoidColors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 48,
  },
  unlockButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});

export default VoidApp;
