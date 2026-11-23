#!/bin/bash
# Regenerates macos/Resources/AppIcon.icns and the dashboard icon PNG from the SVG sources.
# Uses only tools that ship with macOS: swiftc (AppKit renders SVG on macOS 14+) and iconutil.
# The outputs are checked in, so build-app.sh does not run this. Run it after editing AppIcon.svg.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RESOURCES="$HERE/../Resources"
DASHBOARD="$HERE/../../src/dashboard"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

swiftc -framework AppKit "$HERE/render-svg.swift" -o "$WORK/render-svg"

ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  "$WORK/render-svg" "$RESOURCES/AppIcon.svg" "$ICONSET/icon_${size}x${size}.png" "$size"
  "$WORK/render-svg" "$RESOURCES/AppIcon.svg" "$ICONSET/icon_${size}x${size}@2x.png" "$((size * 2))"
done
iconutil --convert icns --output "$RESOURCES/AppIcon.icns" "$ICONSET"

# Dashboard: the SVG favicon is src/dashboard/icon.svg; this PNG is the fallback and touch icon.
"$WORK/render-svg" "$DASHBOARD/icon.svg" "$DASHBOARD/icon.png" 180

echo "Wrote $RESOURCES/AppIcon.icns and $DASHBOARD/icon.png"
