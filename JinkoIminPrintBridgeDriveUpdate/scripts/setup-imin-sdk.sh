#!/usr/bin/env bash
set -euo pipefail

# iMin distributes the Android 7 / SDK 1.x files inside its official demo ZIP.
# This script extracts only the two JARs and the matching native libraries needed
# by the D4. It never checks the downloaded SDK into source control.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/android/app"
SDK_URL="https://imin-sg-resources.oss-ap-southeast-1.aliyuncs.com/docs/demo/iMinPrinter_SDK1.0/iMinPrinterDemo-v1.3.1.zip"
OUTER_PATH="iMinPrinterSDK-v1.3.1/iMinPrinterDemo.zip"
INNER_ROOT="iMinPrinterDemo/IminPrinterDemo/app"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v unzip >/dev/null || { echo "unzip is required" >&2; exit 1; }

mkdir -p "$APP_DIR/libs" "$APP_DIR/src/main"
curl -fL --retry 3 --retry-delay 2 "$SDK_URL" -o "$TEMP_DIR/imin-sdk.zip"
unzip -p "$TEMP_DIR/imin-sdk.zip" "$OUTER_PATH" > "$TEMP_DIR/imin-demo.zip"

unzip -p "$TEMP_DIR/imin-demo.zip" "$INNER_ROOT/libs/IminLibs1.0.15.jar" \
  > "$APP_DIR/libs/IminLibs1.0.15.jar"
unzip -p "$TEMP_DIR/imin-demo.zip" "$INNER_ROOT/libs/iminPrinterSDK-14_V1.3.1_2408141540.jar" \
  > "$APP_DIR/libs/iminPrinterSDK-14_V1.3.1_2408141540.jar"
unzip -q "$TEMP_DIR/imin-demo.zip" "$INNER_ROOT/src/main/jniLibs/*" -d "$TEMP_DIR/extracted"
rm -rf "$APP_DIR/src/main/jniLibs"
cp -R "$TEMP_DIR/extracted/$INNER_ROOT/src/main/jniLibs" "$APP_DIR/src/main/jniLibs"

echo "iMin SDK 1.3.1 installed for D4 / Android 7.1."
