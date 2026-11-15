#!/bin/zsh
# Debug helper: launch Castle on a page and capture its window. usage: shot.sh <section> <out.png> [wait] [extra args]
APP="${0:A:h}/../../build/Build/Products/Debug/Castle.app"
pkill -x Castle; sleep 0.5
open "$APP" --args -startSection "$1" -demo YES ${@:4}
sleep "${3:-5}"; osascript -e 'tell application "Castle" to activate'; sleep 0.6
WID=$(swift "$TMPDIR/winid.swift" 2>/dev/null)
screencapture -x -o -l "$WID" "$2"
