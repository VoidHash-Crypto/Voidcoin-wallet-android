/**
 * VOID Navigation Types
 * Type definitions for VOID-specific navigation
 */

export type VOIDRootStackParamList = {
  VoidWalletList: undefined;
  ClaimAirdrop: undefined;
  VoidReceive: {
    address: string;
    walletLabel?: string;
    isVOID?: boolean;
    walletId?: string;
  };
  VoidSend: {
    walletId: string;
    walletBalance: number;
    walletAddress: string;
    isVOID?: boolean;
  };
  VoidSettings: undefined;
  WalletDetail: {
    walletId: string;
  };
  AddWallet: undefined;
  VoidAppPassword: undefined;
};

// Navigation prop types
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';

export type VoidWalletListNavigationProp = NativeStackNavigationProp<VOIDRootStackParamList, 'VoidWalletList'>;
export type ClaimAirdropNavigationProp = NativeStackNavigationProp<VOIDRootStackParamList, 'ClaimAirdrop'>;
export type VoidReceiveNavigationProp = NativeStackNavigationProp<VOIDRootStackParamList, 'VoidReceive'>;
export type VoidSendNavigationProp = NativeStackNavigationProp<VOIDRootStackParamList, 'VoidSend'>;
export type VoidSettingsNavigationProp = NativeStackNavigationProp<VOIDRootStackParamList, 'VoidSettings'>;

export type VoidReceiveRouteProp = RouteProp<VOIDRootStackParamList, 'VoidReceive'>;
export type VoidSendRouteProp = RouteProp<VOIDRootStackParamList, 'VoidSend'>;
export type WalletDetailRouteProp = RouteProp<VOIDRootStackParamList, 'WalletDetail'>;
