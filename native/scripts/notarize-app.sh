#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
PROJECT_DIR=${SCRIPT_DIR:h:h}
APP_PATH="$PROJECT_DIR/build/AgentCastKit Runner.app"
ZIP_PATH="$PROJECT_DIR/build/AgentCastKit-Runner-macOS-arm64.zip"
PROFILE=${NOTARY_PROFILE:-AgentCastKit}

if [[ ! -d "$APP_PATH" || ! -f "$ZIP_PATH" ]]; then
    print -u2 "Build the signed release first with: npm run native:app"
    exit 1
fi

xcrun notarytool submit "$ZIP_PATH" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"

ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute --verbose=2 "$APP_PATH"
shasum -a 256 "$ZIP_PATH"
