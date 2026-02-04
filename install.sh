#!/bin/sh
set -eu

REPO="${AGENT_SLACK_REPO:-nwparker/agent-slack}"
BIN_NAME="agent-slack"
SKIP_PM="${AGENT_SLACK_SKIP_PM:-0}"
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

log() {
  printf '%s\n' "$*"
}

err() {
  printf '%s\n' "$*" >&2
}

die() {
  err "error: $*"
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

normalize_npm_version() {
  version=$1
  case "$version" in
    v*) printf '%s' "${version#v}" ;;
    *) printf '%s' "$version" ;;
  esac
}

try_package_manager() {
  if [ "$SKIP_PM" = "1" ]; then
    return 1
  fi

  version="${AGENT_SLACK_VERSION:-}"
  if [ -n "$version" ]; then
    npm_version=$(normalize_npm_version "$version")
    package="agent-slack@$npm_version"
  else
    package="agent-slack"
  fi

  if have npm; then
    log "Installing via npm..."
    if npm i -g "$package"; then
      return 0
    fi
    err "npm install failed; falling back to binary install."
    return 1
  fi
  if have pnpm; then
    log "Installing via pnpm..."
    if pnpm add -g "$package"; then
      return 0
    fi
    err "pnpm install failed; falling back to binary install."
    return 1
  fi
  if have bun; then
    log "Installing via bun..."
    if bun add -g "$package"; then
      return 0
    fi
    err "bun install failed; falling back to binary install."
    return 1
  fi
  return 1
}

download() {
  url=$1
  dest=$2
  if have curl; then
    curl -fsSL "$url" -o "$dest"
    return
  fi
  if have wget; then
    wget -qO "$dest" "$url"
    return
  fi
  die "curl or wget is required"
}

hash_file() {
  file=$1
  if have sha256sum; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi
  if have shasum; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi
  if have openssl; then
    openssl dgst -sha256 "$file" | awk '{print $2}'
    return
  fi
  die "sha256sum, shasum, or openssl is required to verify downloads"
}

is_musl() {
  if have ldd; then
    if ldd --version 2>&1 | grep -qi musl; then
      return 0
    fi
    if ldd /bin/sh 2>&1 | grep -qi musl; then
      return 0
    fi
  fi
  if ls /lib/ld-musl-*.so* >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

detect_platform() {
  os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
  case "$os" in
    linux | darwin) platform="$os" ;;
    msys* | mingw* | cygwin*) platform="windows" ;;
    *) die "Unsupported OS: $os (macOS, Linux, Windows)" ;;
  esac

  arch=$(uname -m 2>/dev/null)
  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) die "Unsupported architecture: $arch" ;;
  esac

  musl_suffix=""
  if [ "$platform" = "linux" ] && is_musl; then
    musl_suffix="-musl"
  fi

  exe_suffix=""
  if [ "$platform" = "windows" ]; then
    exe_suffix=".exe"
  fi
}

main() {
  if try_package_manager; then
    log "Done."
    exit 0
  fi

  detect_platform

  asset="${BIN_NAME}-${platform}-${arch}${musl_suffix}${exe_suffix}"
  version="${AGENT_SLACK_VERSION:-}"
  if [ -n "$version" ]; then
    case "$version" in
      v*) tag="$version" ;;
      *) tag="v$version" ;;
    esac
    base_url="https://github.com/$REPO/releases/download/$tag"
  else
    base_url="https://github.com/$REPO/releases/latest/download"
  fi

  tmpdir=$(mktemp -d 2>/dev/null || mktemp -d -t agent-slack.XXXXXX)
  trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM
  bin_tmp="$tmpdir/$asset"
  sums_tmp="$tmpdir/checksums-sha256.txt"

  log "Downloading $asset..."
  download "$base_url/$asset" "$bin_tmp"

  if [ "$SKIP_VERIFY" = "1" ]; then
    log "Skipping checksum verification (AGENT_SLACK_SKIP_VERIFY=1)."
  else
    log "Verifying checksum..."
    download "$base_url/checksums-sha256.txt" "$sums_tmp"
    expected=$(awk -v file="$asset" '$2 == file {print $1; exit}' "$sums_tmp")
    if [ -z "$expected" ]; then
      die "Checksum not found for $asset"
    fi
    actual=$(hash_file "$bin_tmp")
    if [ "$expected" != "$actual" ]; then
      die "Checksum mismatch for $asset"
    fi
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

