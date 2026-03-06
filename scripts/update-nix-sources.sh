#!/usr/bin/env bash
set -euo pipefail

repo="stablyai/agent-slack"
latest_api="https://api.github.com/repos/${repo}/releases/latest"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

if ! command -v nix >/dev/null 2>&1; then
  echo "error: nix is required" >&2
  exit 1
fi

tag="$(curl -fsSL "$latest_api" | jq -r '.tag_name')"
if [[ -z "$tag" || "$tag" == "null" ]]; then
  echo "error: unable to resolve latest release tag" >&2
  exit 1
fi

version="${tag#v}"
checksums_url="https://github.com/${repo}/releases/download/${tag}/checksums-sha256.txt"
checksums="$(curl -fsSL "$checksums_url")"

get_sri() {
  local asset="$1"
  local hex
  hex="$(awk -v asset="$asset" '$2 == asset { print $1 }' <<<"$checksums")"

  if [[ -z "$hex" ]]; then
    echo "error: missing checksum for ${asset}" >&2
    exit 1
  fi

  nix hash convert --hash-algo sha256 --to sri "$hex"
}

arm64_darwin="$(get_sri agent-slack-darwin-arm64)"
x64_darwin="$(get_sri agent-slack-darwin-x64)"
arm64_linux="$(get_sri agent-slack-linux-arm64)"
x64_linux="$(get_sri agent-slack-linux-x64)"

jq -n \
  --arg version "$version" \
  --arg aarch64_darwin "$arm64_darwin" \
  --arg x86_64_darwin "$x64_darwin" \
  --arg aarch64_linux "$arm64_linux" \
  --arg x86_64_linux "$x64_linux" \
  '{
    version: $version,
    hashes: {
      "aarch64-darwin": $aarch64_darwin,
      "x86_64-darwin": $x86_64_darwin,
      "aarch64-linux": $aarch64_linux,
      "x86_64-linux": $x86_64_linux
    }
  }' > nix/sources.json

echo "Updated nix/sources.json to ${version}"
