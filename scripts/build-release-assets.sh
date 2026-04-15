#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' "error: bun is required to build release assets" >&2
  exit 1
fi

version=$(node -p "require('./package.json').version")
tag="v$version"

outdir="release"
mkdir -p "$outdir"

build() {
  target=$1
  outfile=$2
  printf '%s\n' "Building $outfile ($target)"
  bun build src/index.ts --compile --target="$target" --outfile="$outdir/$outfile" --define "AGENT_SLACK_BUILD_VERSION='$version'"
}

build "bun-darwin-arm64" "agent-slack-darwin-arm64"
build "bun-darwin-x64" "agent-slack-darwin-x64"

# Ad-hoc codesign macOS binaries (required for Gatekeeper on modern macOS).
# Cross-compiled Mach-O binaries from `bun build --compile` may carry an
# invalid signature blob that causes macOS to SIGKILL (Killed: 9) on launch.
# `codesign --sign -` stamps a valid ad-hoc signature.
if command -v codesign >/dev/null 2>&1; then
  for f in "$outdir"/agent-slack-darwin-*; do
    printf '%s\n' "Signing $f"
    codesign --sign - --force "$f"
  done
elif command -v rcodesign >/dev/null 2>&1; then
  for f in "$outdir"/agent-slack-darwin-*; do
    printf '%s\n' "Signing $f (rcodesign)"
    # Bun cross-compiled binaries embed a malformed code-signature SuperBlob
    # that rcodesign cannot parse.  Strip it at the Mach-O level first.
    python3 "$(dirname "$0")/strip-macho-signature.py" "$f"
    rcodesign sign "$f"
  done
else
  printf '%s\n' "warning: no codesign or rcodesign found — macOS binaries will be unsigned" >&2
fi

build "bun-linux-x64" "agent-slack-linux-x64"
build "bun-linux-x64-musl" "agent-slack-linux-x64-musl"
build "bun-linux-arm64" "agent-slack-linux-arm64"
build "bun-linux-arm64-musl" "agent-slack-linux-arm64-musl"
build "bun-windows-x64" "agent-slack-windows-x64.exe"

(
  cd "$outdir"
  rm -f checksums-sha256.txt
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum agent-slack-* > checksums-sha256.txt
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 agent-slack-* | awk '{print $1 "  " $2}' > checksums-sha256.txt
  elif command -v openssl >/dev/null 2>&1; then
    for f in agent-slack-*; do
      h=$(openssl dgst -sha256 "$f" | awk '{print $2}')
      printf '%s  %s\n' "$h" "$f"
    done > checksums-sha256.txt
  else
    printf '%s\n' "error: need sha256sum, shasum, or openssl to generate checksums" >&2
    exit 1
  fi
)

printf '%s\n' "Done. Upload assets in $outdir/ to the GitHub release for $tag."

