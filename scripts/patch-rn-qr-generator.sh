#!/bin/bash
# Fix rn-qr-generator to not use TurboModule spec
FILE="node_modules/rn-qr-generator/android/src/main/java/com/gevorg/reactlibrary/RNQrGeneratorModule.java"
if [ -f "$FILE" ]; then
  sed -i 's/extends NativeRNQrGeneratorSpec/extends com.facebook.react.bridge.ReactContextBaseJavaModule/' "$FILE"
  sed -i '/import com.gevorg.reactlibrary.NativeRNQrGeneratorSpec/d' "$FILE"
  echo "Patched rn-qr-generator"
fi
