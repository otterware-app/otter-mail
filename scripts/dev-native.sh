#!/bin/sh
# Runs the native app (crates/otter-mail) and rebuilds and relaunches it
# whenever its Rust sources change. GPUI has no hot reload; this is the next
# best thing. Arguments go to the app (e.g. --demo for the made-up mailboxes).
#
#   scripts/dev-native.sh --demo
set -u
cd "$(dirname "$0")/.."
export OTTER_MAIL_HOME="${OTTER_MAIL_HOME:-$PWD/.otter-mail/native}"

stamp() {
  case "$(uname -s)" in
    Darwin) find crates Cargo.toml Cargo.lock -type f \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' -o -name '*.json' \) -exec stat -f '%m %N' {} + ;;
    *) find crates Cargo.toml Cargo.lock -type f \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' -o -name '*.json' \) -exec stat -c '%Y %n' {} + ;;
  esac | sort -n | tail -1
}

pid=""
last=""
trap 'kill $pid 2>/dev/null; exit 0' INT TERM
while true; do
  now=$(stamp)
  if [ "$now" != "$last" ]; then
    last=$now
    echo "[dev-native] building…"
    if cargo build -p otter-mail; then
      if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; fi
      echo "[dev-native] launching"
      sh scripts/launch-native.sh "$@" &
      pid=$!
    else
      echo "[dev-native] build failed; waiting for changes"
    fi
  fi
  sleep 1
done
