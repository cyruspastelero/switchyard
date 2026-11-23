#!/bin/bash
# Builds a release binary and wraps it into build/Switchyard.app (ad-hoc signed).
# The path and bundle id stay the same across builds. An ad-hoc signature changes
# with every build, so macOS may ask for the Accessibility grant again after a rebuild.
#
# Optional environment (macos/release.sh sets these):
#   SWITCHYARD_BUILD_DIR   where Switchyard.app goes (default macos/build)
#   SWITCHYARD_ARCHS       e.g. "arm64 x86_64" for a universal binary (default: this Mac's arch)
#   SWITCHYARD_TIMESTAMP=1 ask Apple's timestamp server to countersign (needed for notarization)
#   SWITCHYARD_BUNDLE_SERVER=1 copy the server into Contents/Resources/server (the release .dmg does)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="${SWITCHYARD_BUILD_DIR:-$HERE/build}"
APP="$OUT/Switchyard.app"
BUNDLE_ID="ph.pastelero.switchyard"
VERSION="$(sed -nE 's/^  "version": "([^"]+)".*/\1/p' "$ROOT/package.json")"
BUILD_NUMBER="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"
[ -n "$VERSION" ] || { echo "could not read the version from package.json" >&2; exit 1; }

compile_with_swiftc() { # <arch> <output>
  swiftc -O -parse-as-library -target "$1-apple-macos14.0" "$HERE"/Sources/Switchyard/*.swift -o "$2"
}

mkdir -p "$OUT"
if [ -n "${SWITCHYARD_ARCHS:-}" ]; then
  # One swiftc run per architecture, then lipo. Works with only the Command Line Tools.
  SLICES=()
  for arch in $SWITCHYARD_ARCHS; do
    echo "compiling $arch" >&2
    compile_with_swiftc "$arch" "$OUT/Switchyard-$arch"
    SLICES+=("$OUT/Switchyard-$arch")
  done
  BIN="$OUT/Switchyard-universal"
  lipo -create "${SLICES[@]}" -output "$BIN"
else
  # SwiftPM needs a working `xcrun --show-sdk-platform-path` (full Xcode). On a bare Command Line Tools install it
  # fails with `xcrun: error: unable to lookup item 'PlatformPath'`; only then fall back to swiftc. A real compile
  # error is shown and stops the build.
  SWIFT_STATUS=0
  SWIFT_LOG="$(swift build -c release --package-path "$HERE" 2>&1)" || SWIFT_STATUS=$?
  if [ "$SWIFT_STATUS" = 0 ]; then
    BIN="$(swift build -c release --package-path "$HERE" --show-bin-path)/Switchyard"
  else
    case "$SWIFT_LOG" in
      *"unable to lookup item 'PlatformPath'"*)
        echo "swift build is unavailable here (no full Xcode); compiling with swiftc instead" >&2
        mkdir -p "$HERE/.build"
        BIN="$HERE/.build/Switchyard-swiftc"
        compile_with_swiftc "$(uname -m)" "$BIN"
        ;;
      *)
        echo "$SWIFT_LOG" >&2
        echo "swift build failed (exit $SWIFT_STATUS)" >&2
        exit 1
        ;;
    esac
  fi
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Switchyard"
# Checked-in icon; regenerate with macos/scripts/make-icon.sh after editing macos/Resources/AppIcon.svg.
cp "$HERE/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

# In a release the server travels inside the app, so a downloaded copy needs only Node. The menu then
# shows `node .../Resources/server/src/index.ts install-service` when the server is not running.
# A source build leaves it out: there the server runs from the checkout.
if [ "${SWITCHYARD_BUNDLE_SERVER:-}" = 1 ]; then
  SERVER="$APP/Contents/Resources/server"
  mkdir -p "$SERVER"
  cp "$ROOT/package.json" "$ROOT/LICENSE" "$ROOT/NOTICE" "$SERVER/"
  cp -R "$ROOT/src" "$SERVER/src"
  find "$SERVER" -name .DS_Store -delete
fi

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
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
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
TIMESTAMP="--timestamp=none"
[ "${SWITCHYARD_TIMESTAMP:-}" = 1 ] && TIMESTAMP="--timestamp"
codesign --force --options runtime --entitlements "$HERE/Switchyard.entitlements" "$TIMESTAMP" \
  --sign "${SWITCHYARD_SIGN_IDENTITY:--}" --identifier "$BUNDLE_ID" "$APP"
codesign --verify --verbose=1 "$APP"
echo "Built $APP"
