import { DarkTheme, DefaultTheme, useTheme as useThemeBase } from '@react-navigation/native';
import { Appearance } from 'react-native';

// VoidCoin Theme — matches void-coin.net aesthetic
// Dark background, purple/cyan accents

export const BlueDefaultTheme = {
  ...DarkTheme,
  closeImage: require('../img/close-white.png'),
  barStyle: 'light-content',
  scanImage: require('../img/scan-white.png'),
  colors: {
    ...DarkTheme.colors,
    borderWidth: 0.5,
    brandingColor: '#0d0b1a',
    customHeader: '#0d0b1a',
    foregroundColor: '#ffffff',
    borderTopColor: 'rgba(107, 90, 154, 0.3)',
    buttonBackgroundColor: '#6b5a9a',
    buttonTextColor: '#ffffff',
    secondButtonTextColor: '#5ce6e6',
    buttonAlternativeTextColor: '#5ce6e6',
    buttonDisabledBackgroundColor: '#2a2440',
    buttonDisabledTextColor: '#4a4270',
    inputBorderColor: '#3d3460',
    inputBackgroundColor: '#1a1630',
    alternativeTextColor: '#8b80b0',
    alternativeTextColor2: '#5ce6e6',
    buttonBlueBackgroundColor: '#6b5a9a',
    buttonGrayBackgroundColor: '#2a2440',
    incomingBackgroundColor: '#1a2e2e',
    incomingForegroundColor: '#5ce6e6',
    outgoingBackgroundColor: '#2e1a1a',
    outgoingForegroundColor: '#f07070',
    successColor: '#5ce6e6',
    failedColor: '#f07070',
    placeholderTextColor: '#4a4270',
    shadowColor: '#000000',
    inverseForegroundColor: '#0d0b1a',
    hdborderColor: '#6b5a9a',
    hdbackgroundColor: '#1a1630',
    lnborderColor: '#5ce6e6',
    lnbackgroundColor: '#0d1f1f',
    background: '#0d0b1a',
    lightButton: '#2a2440',
    ballReceive: '#1a2e2e',
    ballOutgoing: '#2e1a1a',
    lightBorder: '#2a2440',
    ballOutgoingExpired: '#2a2440',
    modal: '#1a1630',
    formBorder: '#3d3460',
    modalButton: '#6b5a9a',
    darkGray: '#4a4270',
    scanLabel: 'rgba(255,255,255,.2)',
    feeText: '#8b80b0',
    feeLabel: '#5ce6e6',
    feeValue: '#0d0b1a',
    feeActive: 'rgba(92,230,230,.2)',
    labelText: '#ffffff',
    cta2: '#5ce6e6',
    outputValue: '#ffffff',
    elevated: '#1a1630',
    mainColor: '#6b5a9a',
    success: '#1a2e2e',
    successCheck: '#5ce6e6',
    msSuccessBG: '#5ce6e6',
    msSuccessCheck: '#0d0b1a',
    newBlue: '#5ce6e6',
    redBG: '#2e1a1a',
    redText: '#f07070',
    changeBackground: '#2a2020',
    changeText: '#f07070',
    receiveBackground: 'rgba(92,230,230,.15)',
    receiveText: '#5ce6e6',
    navigationBarColor: '#0d0b1a',
    androidRippleColor: '#3d3460',
  },
};

export type Theme = typeof BlueDefaultTheme;

export const BlueDarkTheme: Theme = {
  ...BlueDefaultTheme,
};

export const useTheme = (): Theme => useThemeBase() as Theme;

export const platformColors = {
  background: BlueDefaultTheme.colors.background,
  card: BlueDefaultTheme.colors.modal,
  text: BlueDefaultTheme.colors.foregroundColor,
  secondaryText: BlueDefaultTheme.colors.alternativeTextColor,
  separator: BlueDefaultTheme.colors.lightBorder,
  chevron: BlueDefaultTheme.colors.alternativeTextColor,
};

export class BlueCurrentTheme {
  static colors: Theme['colors'];
  static closeImage: Theme['closeImage'];
  static scanImage: Theme['scanImage'];
  static updateColorScheme(): void {
    BlueCurrentTheme.colors = BlueDefaultTheme.colors;
    BlueCurrentTheme.closeImage = BlueDefaultTheme.closeImage;
    BlueCurrentTheme.scanImage = BlueDefaultTheme.scanImage;
    const colors = BlueCurrentTheme.colors;
    platformColors.background = colors.background;
    platformColors.card = colors.modal;
    platformColors.text = colors.foregroundColor;
    platformColors.secondaryText = colors.alternativeTextColor;
    platformColors.separator = colors.lightBorder;
    platformColors.chevron = colors.alternativeTextColor;
  }
}
BlueCurrentTheme.updateColorScheme();
