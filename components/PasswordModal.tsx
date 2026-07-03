/**
 * Password Modal
 * Reusable modal that prompts for wallet password using PasswordInput.
 * Used in send flow and backup flow.
 */

import React, { useRef, useEffect, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { PasswordInput, PasswordInputHandle } from './PasswordInput';
import { VoidColors, VOIDSpacing, VOIDTypography, VOIDBorderRadius } from './VoidTheme';

interface PasswordModalProps {
  visible: boolean;
  title?: string;
  subtitle?: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

/** Imperative handle exposed via ref for parent control */
export interface PasswordModalHandle {
  showError: () => void;
  showSuccess: () => void;
}

export const PasswordModalWithRef = React.forwardRef<PasswordModalHandle, PasswordModalProps>(
  (props, ref) => {
    const passwordRef = useRef<PasswordInputHandle>(null);

    React.useImperativeHandle(ref, () => ({
      showError: () => passwordRef.current?.showError(),
      showSuccess: () => passwordRef.current?.showSuccess(),
    }));

    useEffect(() => {
      if (props.visible) {
        setTimeout(() => {
          passwordRef.current?.reset();
          passwordRef.current?.focus();
        }, 300);
      } else {
        passwordRef.current?.reset();
      }
    }, [props.visible]);

    const handleSubmit = useCallback((password: string) => {
      props.onSubmit(password);
    }, [props.onSubmit]);

    return (
      <Modal
        visible={props.visible}
        transparent
        animationType="fade"
        onRequestClose={props.onCancel}
      >
        <TouchableWithoutFeedback onPress={props.onCancel}>
          <View style={styles.overlay}>
            <TouchableWithoutFeedback>
              <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              >
                <View style={styles.container}>
                  <Text style={styles.title}>{props.title ?? 'Enter Password'}</Text>
                  <Text style={styles.subtitle}>{props.subtitle ?? 'Enter your wallet password to continue'}</Text>

                  <View style={styles.inputWrapper}>
                    <PasswordInput
                      ref={passwordRef}
                      onSubmit={handleSubmit}
                      placeholder="Wallet password"
                    />
                  </View>

                  <View style={styles.buttons}>
                    <TouchableOpacity style={styles.cancelButton} onPress={props.onCancel}>
                      <Text style={styles.cancelText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.submitButton}
                      onPress={() => {
                        const pwd = passwordRef.current?.getValue();
                        if (pwd) handleSubmit(pwd);
                      }}
                    >
                      <Text style={styles.submitText}>Unlock</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </KeyboardAvoidingView>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    );
  }
);

PasswordModalWithRef.displayName = 'PasswordModalWithRef';

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: VOIDSpacing.lg,
  },
  container: {
    backgroundColor: VoidColors.backgroundCard,
    borderRadius: VOIDBorderRadius.lg,
    padding: VOIDSpacing.xl,
    width: '100%',
    maxWidth: 400,
  },
  title: {
    fontSize: VOIDTypography.fontSize.xl,
    fontWeight: VOIDTypography.fontWeight.bold,
    color: VoidColors.textPrimary,
    textAlign: 'center',
    marginBottom: VOIDSpacing.sm,
  },
  subtitle: {
    fontSize: VOIDTypography.fontSize.sm,
    color: VoidColors.textSecondary,
    textAlign: 'center',
    marginBottom: VOIDSpacing.xl,
  },
  inputWrapper: {
    marginBottom: VOIDSpacing.xl,
  },
  buttons: {
    flexDirection: 'row',
    gap: VOIDSpacing.md,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: VOIDSpacing.md,
    borderRadius: VOIDBorderRadius.md,
    borderWidth: 1,
    borderColor: VoidColors.border,
    alignItems: 'center',
  },
  cancelText: {
    color: VoidColors.textSecondary,
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.medium,
  },
  submitButton: {
    flex: 1,
    paddingVertical: VOIDSpacing.md,
    borderRadius: VOIDBorderRadius.md,
    backgroundColor: VoidColors.primary,
    alignItems: 'center',
  },
  submitText: {
    color: VoidColors.textPrimary,
    fontSize: VOIDTypography.fontSize.base,
    fontWeight: VOIDTypography.fontWeight.bold,
  },
});
