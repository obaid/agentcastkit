#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
NATIVE_DIR=${SCRIPT_DIR:h}
PROJECT_DIR=${NATIVE_DIR:h}
CONFIGURATION=${CONFIGURATION:-release}
APP_NAME="AgentCastKit Runner"
APP_DIR="$PROJECT_DIR/build/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
MCP_DIR="$RESOURCES_DIR/mcp"
IDENTITY=${CODESIGN_IDENTITY:-"Developer ID Application: obaid ahmed (U25ZJ9KG26)"}

swift build --package-path "$NATIVE_DIR" -c "$CONFIGURATION" --arch arm64
npm run build --prefix "$PROJECT_DIR"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$MCP_DIR/dist"
cp "$NATIVE_DIR/.build/$CONFIGURATION/agentcastkit-capture" "$MACOS_DIR/$APP_NAME"
cp "$NATIVE_DIR/App/Info.plist" "$CONTENTS_DIR/Info.plist"
cp -R "$PROJECT_DIR/dist/src" "$MCP_DIR/dist/src"
cp "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" "$MCP_DIR/"

npm ci --prefix "$MCP_DIR" --omit=dev --ignore-scripts --no-audit --no-fund

ICON_WORK=$(mktemp -d)
trap 'rm -rf "$ICON_WORK"' EXIT
mkdir -p "$ICON_WORK/AgentCastKit.iconset"
sips -s format png "$NATIVE_DIR/App/AgentCastKit.svg" --out "$ICON_WORK/icon.png" >/dev/null
for SIZE in 16 32 128 256 512; do
    sips -z "$SIZE" "$SIZE" "$ICON_WORK/icon.png" --out "$ICON_WORK/AgentCastKit.iconset/icon_${SIZE}x${SIZE}.png" >/dev/null
    DOUBLE=$((SIZE * 2))
    sips -z "$DOUBLE" "$DOUBLE" "$ICON_WORK/icon.png" --out "$ICON_WORK/AgentCastKit.iconset/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
done
iconutil -c icns "$ICON_WORK/AgentCastKit.iconset" -o "$RESOURCES_DIR/AgentCastKit.icns"

codesign --force --options runtime --timestamp \
    --entitlements "$NATIVE_DIR/App/AgentCastKitRunner.entitlements" \
    --sign "$IDENTITY" "$MACOS_DIR/$APP_NAME"
codesign --force --options runtime --timestamp \
    --entitlements "$NATIVE_DIR/App/AgentCastKitRunner.entitlements" \
    --sign "$IDENTITY" "$APP_DIR"

node "$NATIVE_DIR/scripts/smoke-packaged-app.mjs" "$APP_DIR"

ditto -c -k --keepParent "$APP_DIR" "$PROJECT_DIR/build/AgentCastKit-Runner-macOS-arm64.zip"

codesign --verify --deep --strict --verbose=2 "$APP_DIR"
spctl --assess --type execute --verbose=2 "$APP_DIR" || true

print "$APP_DIR"
