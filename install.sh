#!/bin/sh
set -eu

REPO="${AGENT_SLACK_REPO:-nwparker/agent-slack}"
BIN_NAME="agent-slack"
SKIP_VERIFY="${AGENT_SLACK_SKIP_VERIFY:-0}"

if [ -n "${AGENT_SLACK_INSTALL_DIR:-}" ]; then
  INSTALL_DIR="$AGENT_SLACK_INSTALL_DIR"
else
  if [ -z "${HOME:-}" ]; then
    printf '%s\n' "error: HOME is not set; set AGENT_SLACK_INSTALL_DIR to install." >&2
    exit 1
  fi
  INSTALL_DIR="$HOME/.local/bin"
fi

log() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }
die() { err "error: $*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

download() {
  url=$1; dest=$2
  if have curl; then
    curl -fsSL "$url" -o "$dest"; return
  fi
  if have wget; then
    wget -qO "$dest" "$url"; return
  fi
  die "curl or wget is required"
}

hash_file() {
  file=$1
  if have sha256sum; then sha256sum "$file" | awk '{print $1}'; return; fi
  if have shasum; then shasum -a 256 "$file" | awk '{print $1}'; return; fi
  if have openssl; then openssl dgst -sha256 "$file" | awk '{print $2}'; return; fi
  die "sha256sum, shasum, or openssl is required to verify downloads"
}

is_musl() {
  if have ldd; then
    ldd --version 2>&1 | grep -qi musl && return 0
    ldd /bin/sh 2>&1 | grep -qi musl && return 0
  fi
  ls /lib/ld-musl-*.so* >/dev/null 2>&1 && return 0
  return 1
}

detect_platform() {
  os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
  case "$os" in
    linux | darwin) platform="$os" ;;
    msys* | mingw* | cygwin*) platform="windows" ;;
    *) die "Unsupported OS: $os" ;;
  esac

  arch=$(uname -m 2>/dev/null)
  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) die "Unsupported architecture: $arch" ;;
  esac

  musl_suffix=""
  [ "$platform" = "linux" ] && is_musl && musl_suffix="-musl"

  exe_suffix=""
  [ "$platform" = "windows" ] && exe_suffix=".exe"
}

main() {
  detect_platform

  asset="${BIN_NAME}-${platform}-${arch}${musl_suffix}${exe_suffix}"
  version="${AGENT_SLACK_VERSION:-}"
  if [ -n "$version" ]; then
    case "$version" in v*) tag="$version" ;; *) tag="v$version" ;; esac
    base_url="https://github.com/$REPO/releases/download/$tag"
  else
    base_url="https://github.com/$REPO/releases/latest/download"
  fi

  tmpdir=$(mktemp -d 2>/dev/null || mktemp -d -t agent-slack.XXXXXX)
  trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM
  bin_tmp="$tmpdir/$asset"

  log "Downloading $asset..."
  download "$base_url/$asset" "$bin_tmp"

  if [ "$SKIP_VERIFY" != "1" ]; then
    log "Verifying checksum..."
    sums_tmp="$tmpdir/checksums-sha256.txt"
    download "$base_url/checksums-sha256.txt" "$sums_tmp"
    expected=$(awk -v file="$asset" '$2 == file {print $1; exit}' "$sums_tmp")
    [ -z "$expected" ] && die "Checksum not found for $asset"
    actual=$(hash_file "$bin_tmp")
    [ "$expected" != "$actual" ] && die "Checksum mismatch for $asset"
  fi

  mkdir -p "$INSTALL_DIR"
  cp "$bin_tmp" "$INSTALL_DIR/$BIN_NAME$exe_suffix"
  chmod 755 "$INSTALL_DIR/$BIN_NAME$exe_suffix"
  log "Installed $BIN_NAME to $INSTALL_DIR/$BIN_NAME$exe_suffix"

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) log "Add to PATH: export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
  esac
}

main "$@"
