#!/usr/bin/env bash
set -euo pipefail

# Target-native, read-only acceptance helper. It never signs, notarizes, or
# publishes an artifact; those operations belong to protected release CI.
artifact="${1:-}"
if [[ -z "$artifact" || ! -f "$artifact" || -L "$artifact" ]]; then
  echo "usage: verify-macos-release.sh <dmg-or-zip>" >&2
  exit 2
fi

require_regular_executable() {
  local file="$1"
  if [[ ! -f "$file" || -L "$file" || ! -x "$file" ]]; then
    echo "required runtime is not a regular executable: $file" >&2
    exit 1
  fi
}

require_regular_file() {
  local file="$1"
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "required runtime manifest is not a regular file: $file" >&2
    exit 1
  fi
}
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS release verification must run on macOS" >&2
  exit 2
fi

case "$artifact" in
  *.dmg)
    hdiutil verify "$artifact" >/dev/null
    mount_point="$(mktemp -d "${TMPDIR:-/tmp}/lnwjud-macos-verify.XXXXXX")"
    device="$(hdiutil attach -nobrowse -readonly -mountpoint "$mount_point" "$artifact" | awk 'END { print $1 }')"
    trap 'hdiutil detach "$device" >/dev/null 2>&1 || true; rm -rf "$mount_point"' EXIT
    app_path="$(find "$mount_point" -maxdepth 2 -name 'lnwjud.app' -type d -print -quit)"
    ;;
  *.zip)
    mount_point="$(mktemp -d "${TMPDIR:-/tmp}/lnwjud-macos-verify.XXXXXX")"
    ditto -x -k "$artifact" "$mount_point"
    trap 'rm -rf "$mount_point"' EXIT
    app_path="$(find "$mount_point" -maxdepth 3 -name 'lnwjud.app' -type d -print -quit)"
    ;;
  *)
    echo "expected a .dmg or .zip macOS artifact" >&2
    exit 2
    ;;
esac

if [[ -z "${app_path:-}" || ! -d "$app_path" ]]; then
  echo "lnwjud.app was not found in the artifact" >&2
  exit 1
fi
require_regular_executable "$app_path/Contents/MacOS/lnwjud"
require_regular_executable "$app_path/Contents/lnwjud-mcp-stdio"
require_regular_executable "$app_path/Contents/Resources/runtime-tools/ripgrep/rg"
require_regular_executable "$app_path/Contents/Resources/tunnel-client/tunnel-client"
machine_arch="$(uname -m)"
case "$machine_arch" in
  arm64) runtime_arch="arm64" ;;
  x86_64) runtime_arch="x64" ;;
  *) echo "unsupported macOS architecture: $machine_arch" >&2; exit 1 ;;
esac
require_regular_executable "$app_path/Contents/Resources/native-host/macos/$runtime_arch/lnwjud-macos-host"
require_regular_file "$app_path/Contents/Resources/native-host/macos/$runtime_arch/NATIVE_HOST.json"

if [[ "${LNWJUD_REQUIRE_CODESIGN:-0}" == "1" ]]; then
  codesign --verify --deep --strict --test-requirement '=anchor apple generic' "$app_path"
else
  if codesign --verify --deep --strict "$app_path" >/dev/null 2>&1; then
    echo "macOS signature integrity verified (may be ad-hoc; not Developer ID proof): $app_path"
  else
    echo "macOS artifact is unsigned; continuing with layout verification (set LNWJUD_REQUIRE_CODESIGN=1 for a release gate)" >&2
  fi
fi
if [[ "${LNWJUD_REQUIRE_NOTARIZATION:-0}" == "1" ]]; then
  spctl --assess --type execute "$app_path"
  xcrun stapler validate "$app_path"
fi
echo "macOS artifact verification completed: $artifact"
