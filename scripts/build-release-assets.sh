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
  bun build src/index.ts --compile --target="$target" --outfile="$outdir/$outfile"
}

build "bun-darwin-arm64" "agent-slack-darwin-arm64"
build "bun-darwin-x64" "agent-slack-darwin-x64"
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

