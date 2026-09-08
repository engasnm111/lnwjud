#!/usr/bin/env bash
set -euo pipefail

# Behavioral layout tests only: no Electron, native-provider, or real AppImage
# execution is exercised. DEBs are real dpkg-deb archives and are never installed.
# Run from the repository root on Linux:
#   bash tests/packaging/linux-release-layout.sh
# For a CRLF checkout under WSL Ubuntu:
#   sed 's/\r$//' tests/packaging/linux-release-layout.sh | bash -s -- "$PWD"
repository_root="${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}"
for tool in dpkg-deb file cc mktemp sed cp find; do
  command -v "$tool" >/dev/null || { echo "Missing test prerequisite: $tool" >&2; exit 2; }
done
[[ "$(uname -s)" == Linux ]] || { echo 'These tests require Linux.' >&2; exit 2; }

scratch="$(mktemp -d /tmp/lnwjud-linux-layout-test.XXXXXXXX)"
cleanup() {
  # Only remove the exact private directory allocated above, including on failure.
  case "$scratch" in
    /tmp/lnwjud-linux-layout-test.?*) rm -rf -- "$scratch" ;;
    *) echo "Refusing unexpected cleanup path: $scratch" >&2 ;;
  esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$scratch/caller/artifacts with spaces" "$scratch/verifier tmp"
# Normalize a disposable copy; never rewrite the production verifier.
sed 's/\r$//' "$repository_root/scripts/verify-linux-release.sh" > "$scratch/verify.sh"
export TMPDIR="$scratch/verifier tmp"

# Use a real ELF fixture so file(1)'s ELF check is exercised without relying on
# the .AppImage filename. This only implements the extraction protocol via cp.
cat > "$scratch/extract-fixture.c" <<'C'
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  const char *payload = getenv("LNWJUD_LAYOUT_TEST_PAYLOAD");
  if (argc != 2 || strcmp(argv[1], "--appimage-extract") != 0 || !payload) {
    fputs("layout fixture expects --appimage-extract and a payload\n", stderr);
    return 2;
  }
  execlp("cp", "cp", "-a", "--", payload, "squashfs-root", (char *)NULL);
  perror("fixture extraction");
  return 1;
}
C
cc -Wall -Wextra -Werror "$scratch/extract-fixture.c" -o "$scratch/extract-fixture"
file -b "$scratch/extract-fixture" | grep -q ELF

make_payload() {
  local root="$1" runtime
  mkdir -p "$root/resources/runtime-tools" "$root/resources/tunnel-client" \
    "$root/resources/native-host/linux"
  for runtime in lnwjud lnwjud-mcp-stdio resources/runtime-tools/rg \
    resources/tunnel-client/tunnel-client resources/native-host/linux/lnwjud-linux-host; do
    # These ELF executables are inert stand-ins, not the packaged application.
    cp -- /bin/true "$root/$runtime"
    chmod 755 "$root/$runtime"
  done
  printf '%s\n' '{}' > "$root/resources/native-host/linux/NATIVE_HOST.json"
}

passed=0
run_case() {
  local format="$1" missing="$2" expected="$3" name root artifact status=0
  name="$format-$missing"
  root="$scratch/payload-$name"
  make_payload "$root"
  case "$missing" in
    complete) ;;
    app) rm -- "$root/lnwjud" ;;
    native-host) rm -- "$root/resources/native-host/linux/lnwjud-linux-host" ;;
    manifest) rm -- "$root/resources/native-host/linux/NATIVE_HOST.json" ;;
  esac
  artifact="artifacts with spaces/$name fixture.$format"
  if [[ "$format" == deb ]]; then
    mkdir -p "$scratch/deb-$name/DEBIAN" "$scratch/deb-$name/opt"
    cp -a -- "$root" "$scratch/deb-$name/opt/lnwjud"
    printf '%s\n' 'Package: lnwjud-layout-fixture' 'Version: 1.0.0' \
      'Architecture: all' 'Maintainer: Layout Test <test@example.invalid>' \
      'Description: Layout-only test fixture, not the lnwjud application' \
      > "$scratch/deb-$name/DEBIAN/control"
    chmod 755 "$scratch/deb-$name/DEBIAN"
    dpkg-deb --root-owner-group --build "$scratch/deb-$name" \
      "$scratch/caller/$artifact" > "$scratch/build-$name.log" 2>&1
  else
    cp -- "$scratch/extract-fixture" "$scratch/caller/$artifact"
  fi
  # Run from a different directory with a relative artifact path containing
  # spaces. AppImage extraction changes cwd again inside the production script.
  (cd -- "$scratch/caller" && LNWJUD_LAYOUT_TEST_PAYLOAD="$root" \
    bash "$scratch/verify.sh" "$artifact") > "$scratch/result-$name.log" 2>&1 || status=$?
  if [[ "$status" != "$expected" ]]; then
    cat "$scratch/result-$name.log" >&2
    echo "FAIL $name: expected exit $expected, got $status" >&2
    exit 1
  fi
  if [[ "$expected" == 0 ]]; then
    grep -Fq 'Linux artifact layout verification passed:' "$scratch/result-$name.log"
  else
    if grep -Fq 'Linux artifact layout verification passed:' "$scratch/result-$name.log"; then
      echo "FAIL $name: rejected artifact reported success" >&2
      exit 1
    fi
  fi
  if [[ -n "$(find "$TMPDIR" -mindepth 1 -print -quit)" ]]; then
    echo "FAIL $name: verifier leaked its extraction directory" >&2
    exit 1
  fi
  passed=$((passed + 1))
  printf 'PASS %s (exit %s)\n' "$name" "$status"
}

for format in deb AppImage; do
  run_case "$format" complete 0
  run_case "$format" app 1
  run_case "$format" native-host 1
  run_case "$format" manifest 1
done
printf '%s layout behavioral tests passed (fixtures only; no actual app testing).\n' "$passed"
