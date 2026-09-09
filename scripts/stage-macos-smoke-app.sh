#!/usr/bin/env bash
set -euo pipefail

artifact="${1:-}"
destination="${2:-}"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS package launch smoke must run on macOS" >&2
  exit 2
fi
if [[ -z "$artifact" || ! -f "$artifact" || -L "$artifact" || -z "$destination" ]]; then
  echo "usage: stage-macos-smoke-app.sh <dmg-or-zip> <destination-app>" >&2
  exit 2
fi
if [[ "$destination" != *.app ]]; then
  echo "destination must end in .app" >&2
  exit 2
fi

scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lnwjud-installed-smoke.XXXXXX")"
device=''
cleanup() {
  if [[ -n "${destination:-}" ]]; then
    while IFS= read -r candidate_pid; do
      [[ -n "$candidate_pid" ]] && kill -TERM "$candidate_pid" >/dev/null 2>&1 || true
    done < <(pgrep -f "$destination/Contents/MacOS/lnwjud" 2>/dev/null || true)
  fi
  if [[ -n "$device" ]]; then hdiutil detach "$device" >/dev/null 2>&1 || true; fi
  rm -rf "$scratch"
}

dump_launch_diagnostics() {
  echo "--- macOS launch diagnostics ---" >&2
  /usr/bin/log show --last 2m --style compact --predicate 'process == "lnwjud" OR eventMessage CONTAINS[c] "lnwjud"' 2>/dev/null | tail -n 120 >&2 || true
  echo "--- end macOS launch diagnostics ---" >&2
}
trap cleanup EXIT

case "$artifact" in
  *.dmg)
    mount_point="$scratch/mount"
    mkdir -p "$mount_point"
    device="$(hdiutil attach -nobrowse -readonly -mountpoint "$mount_point" "$artifact" | awk 'END { print $1 }')"
    source_app="$(find "$mount_point" -maxdepth 2 -name 'lnwjud.app' -type d -print -quit)"
    ;;
  *.zip)
    extract_root="$scratch/extracted"
    mkdir -p "$extract_root"
    ditto -x -k "$artifact" "$extract_root"
    source_app="$(find "$extract_root" -maxdepth 3 -name 'lnwjud.app' -type d -print -quit)"
    ;;
  *)
    echo "expected a .dmg or .zip macOS artifact" >&2
    exit 2
    ;;
esac

if [[ -z "${source_app:-}" || ! -d "$source_app" ]]; then
  echo "lnwjud.app was not found in the packaged artifact" >&2
  exit 1
fi
mkdir -p "$(dirname "$destination")"
rm -rf "$destination"
ditto "$source_app" "$destination"

executable="$destination/Contents/MacOS/lnwjud"
if [[ ! -f "$executable" || -L "$executable" || ! -x "$executable" ]]; then
  echo "installed macOS executable is invalid: $executable" >&2
  exit 1
fi
codesign --verify --deep --strict "$destination"

# Launch through LaunchServices, not by exec'ing the Mach-O directly. This is
# the boundary a user hits after copying the app out of the DMG/ZIP.
open -n "$destination"
pid=''
for _ in {1..30}; do
  pid="$(pgrep -f "$executable" | head -n 1 || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 1
done
if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
  echo "LaunchServices did not keep lnwjud running from the packaged app" >&2
  dump_launch_diagnostics
  exit 1
fi
sleep 3
if ! kill -0 "$pid" 2>/dev/null; then
  echo "lnwjud exited during packaged LaunchServices startup smoke" >&2
  dump_launch_diagnostics
  exit 1
fi
kill -TERM "$pid" 2>/dev/null || true
for _ in {1..20}; do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.25
done
if kill -0 "$pid" 2>/dev/null; then
  kill -KILL "$pid" 2>/dev/null || true
fi

echo "Installed macOS package launch smoke passed: $destination" >&2
echo "$executable"
