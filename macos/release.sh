#!/bin/bash
# Builds the release .dmg: universal Switchyard.app signed with Developer ID (hardened runtime,
# timestamp), packed into a signed disk image, notarized and stapled. Output goes to dist/macos/.
#
#   SWITCHYARD_SIGN_IDENTITY   required: SHA-1 of a "Developer ID Application" identity
#                              (security find-identity -v -p codesigning)
#   SWITCHYARD_NOTARY_PROFILE  notarytool keychain profile (default: switchyard-notary). Created once with
#                              xcrun notarytool store-credentials switchyard-notary --apple-id <id> --team-id <team>
#   SWITCHYARD_ARCHS           default "arm64 x86_64"
#
# Notarization is skipped, with a message, when the profile is missing. Nothing is uploaded anywhere else.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="$ROOT/dist/macos"
VERSION="$(sed -nE 's/^  "version": "([^"]+)".*/\1/p' "$ROOT/package.json")"
PROFILE="${SWITCHYARD_NOTARY_PROFILE:-switchyard-notary}"
IDENTITY="${SWITCHYARD_SIGN_IDENTITY:-}"
APP="$OUT/Switchyard.app"
DMG="$OUT/Switchyard-$VERSION.dmg"

step() { printf '\n==> %s\n' "$*"; }
fail() { echo "release: $*" >&2; exit 1; }

[ -n "$VERSION" ] || fail "could not read the version from package.json"
[ -n "$IDENTITY" ] || fail "set SWITCHYARD_SIGN_IDENTITY to the SHA-1 of your Developer ID Application identity (security find-identity -v -p codesigning)"
# Exact match on the SHA-1 column. No pipe into `grep -q`: under pipefail its early exit can SIGPIPE the writer.
IDENTITIES="$(security find-identity -v -p codesigning)" || fail "security find-identity failed"
WANTED="$(tr '[:lower:]' '[:upper:]' <<<"$IDENTITY")"
awk -v id="$WANTED" '$2 == id && /"Developer ID Application: /{ found = 1 } END { exit !found }' <<<"$IDENTITIES" \
  || fail "SWITCHYARD_SIGN_IDENTITY is not a valid Developer ID Application identity in your keychain"

step "Building Switchyard $VERSION"
rm -rf "$OUT"
mkdir -p "$OUT"
SWITCHYARD_BUILD_DIR="$OUT" SWITCHYARD_ARCHS="${SWITCHYARD_ARCHS:-arm64 x86_64}" SWITCHYARD_TIMESTAMP=1 SWITCHYARD_BUNDLE_SERVER=1 \
  SWITCHYARD_SIGN_IDENTITY="$IDENTITY" bash "$HERE/build-app.sh"
rm -f "$OUT"/Switchyard-arm64 "$OUT"/Switchyard-x86_64 "$OUT"/Switchyard-universal
lipo -info "$APP/Contents/MacOS/Switchyard"

step "Verifying the app signature"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign --display --verbose=2 "$APP" 2>&1 | grep -E '^(Identifier|Format|Timestamp|Runtime Version|flags)|^CodeDirectory' || true
# Before notarization Gatekeeper answers "Unnotarized Developer ID"; that is expected here.
spctl -a -vv "$APP" || echo "(spctl rejects the app until it is notarized)"

step "Packing $DMG"
STAGE="$(mktemp -d "$OUT/stage.XXXXXX")"
ditto "$APP" "$STAGE/Switchyard.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Switchyard $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG"
rm -rf "$STAGE"
codesign --force --sign "$IDENTITY" --timestamp "$DMG"
codesign --verify --strict --verbose=2 "$DMG"

step "Notarizing"
# A missing profile skips notarization. Any other failure (offline, expired password) stops the release.
HISTORY_STATUS=0
HISTORY="$(xcrun notarytool history --keychain-profile "$PROFILE" 2>&1)" || HISTORY_STATUS=$?
MISSING_PROFILE=0
case "$HISTORY" in *"No Keychain password item found for profile"*) MISSING_PROFILE=1 ;; esac
if [ "$MISSING_PROFILE" = 0 ] && [ "$HISTORY_STATUS" != 0 ]; then
  echo "$HISTORY" >&2
  fail "notarytool history failed (exit $HISTORY_STATUS); fix that and run again"
fi
if [ "$MISSING_PROFILE" = 1 ]; then
  cat <<EOF
Skipped: no notarytool keychain profile named "$PROFILE".
Create it once (it asks for an app-specific password from account.apple.com):
  xcrun notarytool store-credentials $PROFILE --apple-id <your Apple ID> --team-id <your team id>
Then run this script again. The .dmg below is signed but not notarized, so Gatekeeper will block it on other Macs.
EOF
  NOTARIZED=0
else
  RESULT="$(xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait 2>&1)" || true
  echo "$RESULT"
  if ! grep -q 'status: Accepted' <<<"$RESULT"; then
    SUBMISSION="$(sed -nE 's/^ *id: ([0-9a-f-]+).*/\1/p' <<<"$RESULT" | head -1)"
    [ -n "$SUBMISSION" ] && xcrun notarytool log "$SUBMISSION" --keychain-profile "$PROFILE" || true
    fail "notarization was not accepted"
  fi
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  NOTARIZED=1
fi

step "Gatekeeper check on the .dmg"
if [ "$NOTARIZED" = 1 ]; then
  spctl -a -t open --context context:primary-signature -vv "$DMG"
else
  spctl -a -t open --context context:primary-signature -vv "$DMG" || echo "(expected to fail until the .dmg is notarized)"
fi

(cd "$OUT" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")
step "Done"
echo "$DMG"
cat "$DMG.sha256"
[ "$NOTARIZED" = 1 ] && echo "Signed, notarized and stapled." || echo "Signed, NOT notarized."
