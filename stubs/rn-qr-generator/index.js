// rn-qr-generator stub for VoidCoin build
// QR generation handled by react-native-qrcode-svg instead
const RNQRGenerator = {
  generate: (options) => Promise.resolve({ uri: '', width: 0, height: 0 }),
  detect: (options) => Promise.resolve({ values: [] }),
};
export default RNQRGenerator;
