#!/bin/zsh
# Builds Castle for this Mac with Wasabi bundled, signed for updates, and installs it.
set -e
cd "${0:A:h}/.."
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/castle-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npx tauri build
if [[ "$1" == "--install" ]]; then
  pkill -x castle 2>/dev/null || true
  rm -rf /Applications/Castle.app
  ditto src-tauri/target/release/bundle/macos/Castle.app /Applications/Castle.app
  echo "Installed /Applications/Castle.app"
fi
