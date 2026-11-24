#!/bin/sh
# Package the app, install it on a TV and launch it.
#   ./deploy.sh [--no-launch]
# DEVICE: ares device name (default "c2"; see `ares-setup-device --list`).
# Uses ares-* from PATH (npm i -g @webos-tools/cli), or ../tools/node_modules/.bin if present.
set -e
cd "$(dirname "$0")"
DEVICE="${DEVICE:-c2}"
[ -d ../tools/node_modules/.bin ] && PATH="$(cd ../tools/node_modules/.bin && pwd):$PATH"
V=$(node -p "require('./app/appinfo.json').version")
ares-package --no-minify -o build app | tail -1
ares-install -d "$DEVICE" "build/com.dvanders.heinetwork_${V}_all.ipk" | tail -1
[ "$1" = "--no-launch" ] || ares-launch -d "$DEVICE" com.dvanders.heinetwork | tail -1
