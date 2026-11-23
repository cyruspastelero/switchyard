#!/bin/bash
# Builds a release binary and wraps it into build/Switchyard.app (ad-hoc signed).
# The path and bundle id stay the same across builds. An ad-hoc signature changes
# with every build, so macOS may ask for the Accessibility grant again after a rebuild.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/build/Switchyard.app"
BUNDLE_ID="ph.pastelero.switchyard"

# SwiftPM needs a working `xcrun --show-sdk-platform-path` (full Xcode). On a bare Command Line
# Tools install it fails, so fall back to compiling the same sources with swiftc.
if swift build -c release --package-path "$HERE" 2>/dev/null; then
  BIN="$(swift build -c release --package-path "$HERE" --show-bin-path)/Switchyard"
else
  echo "swift build is unavailable here; compiling with swiftc instead" >&2
  mkdir -p "$HERE/.build"
  BIN="$HERE/.build/Switchyard-swiftc"
  swiftc -O -parse-as-library -target "$(uname -m)-apple-macos14.0" "$HERE"/Sources/Switchyard/*.swift -o "$BIN"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Switchyard"
# Checked-in icon; regenerate with macos/scripts/make-icon.sh after editing macos/Resources/AppIcon.svg.
cp "$HERE/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Switchyard</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>Switchyard</string>
  <key>CFBundleDisplayName</key><string>Switchyard</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>Switchyard reads and arranges your Chrome and Arc windows and tabs so it can sort them by project.</string>
</dict>
</plist>
PLIST

# Ad-hoc by default. Set SWITCHYARD_SIGN_IDENTITY to a code-signing identity from your keychain (a self-signed
# one is enough) and macOS keeps the Accessibility and Automation grants across rebuilds.
# Hardened runtime: other processes cannot inject code into the app (DYLD_INSERT_LIBRARIES, task ports) and so
# cannot borrow its Accessibility and Automation grants. The one entitlement lets it send Apple Events to
# Chrome and Arc; there are no others (no network server, no file access, no JIT, no library loading).
codesign --force --options runtime --entitlements "$HERE/Switchyard.entitlements" \
  --sign "${SWITCHYARD_SIGN_IDENTITY:--}" --identifier "$BUNDLE_ID" "$APP"
codesign --verify --verbose=1 "$APP"
echo "Built $APP"
