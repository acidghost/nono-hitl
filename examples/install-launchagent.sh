#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
    echo "This script requires macOS." >&2
    exit 1
fi

binary=$(command -v nono-hitl) || {
    echo "Install nono-hitl and add it to PATH first." >&2
    exit 1
}
case "$binary" in
/*) ;;
*)
    echo "nono-hitl must resolve to an absolute path in PATH." >&2
    exit 1
    ;;
esac

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
plist="$HOME/Library/LaunchAgents/nono-hitl.plist"
log_dir="$HOME/Library/Logs/nono-hitl"

mkdir -p "$HOME/Library/LaunchAgents" "$log_dir"
cp "$script_dir/nono-hitl.plist" "$plist"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $binary" "$plist"
/usr/libexec/PlistBuddy -c "Set :StandardOutPath $log_dir/stdout.log" "$plist"
/usr/libexec/PlistBuddy -c "Set :StandardErrorPath $log_dir/stderr.log" "$plist"
plutil -lint "$plist"
launchctl bootstrap "gui/$(id -u)" "$plist"
