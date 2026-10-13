#!/bin/sh
# Launch the built GPUI app with its own development bundle and Dock icon.
set -eu
cd "$(dirname "$0")/.."
export OTTER_MAIL_HOME="${OTTER_MAIL_HOME:-$PWD/.otter-mail/native}"

if [ "$(uname -s)" = Darwin ]; then
  native_bundle="$PWD/.otter-mail/native-app/Otter Mail GPUI.app"
  mkdir -p "$native_bundle/Contents/MacOS" "$native_bundle/Contents/Resources"
  cp -c target/debug/otter-mail "$native_bundle/Contents/MacOS/otter-mail"
  cp assets/dev/blueprint-macos-1024.png "$native_bundle/Contents/Resources/icon.png"
  cat > "$native_bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.otterware.mail.gpui</string>
  <key>CFBundleName</key><string>Otter Mail GPUI</string>
  <key>CFBundleDisplayName</key><string>Otter Mail GPUI</string>
  <key>CFBundleExecutable</key><string>otter-mail</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleIconFile</key><string>icon.png</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
  exec "$native_bundle/Contents/MacOS/otter-mail" "$@"
fi

exec ./target/debug/otter-mail "$@"
