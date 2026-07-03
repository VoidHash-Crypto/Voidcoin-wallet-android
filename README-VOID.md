# VoidCoin VOID Edition

A mobile wallet for **VoidCoin (VOID)** with support for both BC2 and VOID chains.

## Features

- **Dual Chain Support**: Manage both BC2 and VOID wallets in one app
- **VOID Airdrop Claim**: Automatically claim your VOID from existing BC2 wallets
- **CashAddr Format**: Native support for `bitcoincashii:` addresses
- **No SegWit**: VOID follows BCH consensus rules (no SegWit support)
- **Privacy First**: No KYC, no registration, your keys = your coins

## VOID Fork Information

VOID forks from BC2 at **block 53,200**. If you held BC2 at the fork height, you automatically have the same balance on VOID.

### Claiming Your VOID Airdrop

1. Import your BC2 wallet using your seed phrase or private key
2. The app will automatically detect your VOID balance
3. Send your VOID to any VOID-compatible wallet

## Building from Source

### Prerequisites

- Node.js 18+
- React Native CLI
- Android Studio (for Android builds)
- Xcode (for iOS builds)

### Android Build

```bash
# Install dependencies
npm install

# Build APK
cd android
./gradlew assembleRelease
```

The APK will be at `android/app/build/outputs/apk/release/app-release.apk`

### iOS Build

```bash
# Install dependencies
npm install
cd ios && pod install && cd ..

# Build IPA (requires Apple Developer account for distribution)
npx react-native build-ios --mode Release
```

## Download

Pre-built APKs are available at:
- [GitHub Releases](https://github.com/BitcoincashII/voidcoin-void/releases)
- [void.org/wallet](https://void.org/wallet)

## Technical Details

- **VOID Electrum Server**: `electrum.void.org:50002` (SSL)
- **Address Format**: CashAddr (`bitcoincashii:q...`)
- **Derivation Path**: m/44'/145'/0' (BCH standard)

## Security

- All keys are stored locally on your device
- Mnemonic phrases are encrypted
- No server-side storage of private keys
- Open source and auditable

## License

MIT License - Based on [VoidCoin](https://github.com/VoidCoin/VoidCoin)

## Support

- Discord: https://discord.gg/void
- GitHub Issues: https://github.com/BitcoincashII/voidcoin-void/issues
