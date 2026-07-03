# VoidCoin Wallet

The official mobile wallet for VoidCoin (VOID) and BitcoinII (BC2).

## Features

- **VOID & BC2 Support** - Full wallet support for both chains
- **Create & Import Wallets** - Generate new wallets or restore from seed phrase
- **VOID Airdrop Claiming** - Claim VOID from BC2 holdings at fork height 53,200
- **Non-Custodial** - Your keys, your coins
- **CashAddr Format** - VOID uses `bitcoincashii:` address prefix
- **Legacy Format** - BC2 uses standard legacy addresses
- **Electrum Connection** - Fast sync via Electrum servers
- **QR Code Support** - Scan and generate QR codes

## Download

Download the latest APK from [Releases](https://github.com/BitcoincashII/Bitcoin-Cash-II-Wallet-Android/releases).

## Electrum Servers

**VOID:**
- electrum.void.org:50002 (SSL)
- electrum2.void.org:50002 (SSL)

**BC2:**
- bc2electrum.void.org:50010 (TCP) / :50011 (SSL)

## Block Explorers

- **VOID:** https://explorer.void.org
- **BC2:** https://explorer.bitcoin-ii.org

## Network Information

| Parameter | VOID | BC2 |
|-----------|------|-----|
| Address Format | CashAddr (`bitcoincashii:`) | Legacy (`1...`) |
| Fork Height | Block 53,200 | - |
| Derivation Path | m/44'/145'/0' | m/44'/0'/0' |

## Building from Source

### Requirements

- Node.js 20+
- Java 17+
- Android SDK 35
- Yarn

### Build

```bash
yarn install
cd android
./gradlew assembleRelease
```

APK output: `android/app/build/outputs/apk/release/app-release-unsigned.apk`

## Support

- **Report Bugs:** dev@bitcoincashii.org
- **Website:** https://void.org
- **BC2 Website:** https://bitcoin-ii.org

## Credits

This wallet is a fork of [VoidCoin](https://github.com/VoidCoin/VoidCoin), adapted for VoidCoin.

## License

MIT License - see [LICENSE](LICENSE)
