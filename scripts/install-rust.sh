#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_HOME="$PWD/.toolchain/cargo"
export RUSTUP_HOME="$PWD/.toolchain/rustup"
export TMPDIR="$PWD/.tmp"
export RUSTUP_DIST_SERVER="https://rsproxy.cn"
export RUSTUP_UPDATE_ROOT="https://rsproxy.cn/rustup"
curl --http1.1 --connect-timeout 15 --max-time 150 --retry 1 -fL https://rsproxy.cn/rustup/dist/x86_64-unknown-linux-gnu/rustup-init -o .tmp/rustup-init
chmod +x .tmp/rustup-init
.tmp/rustup-init -y --profile minimal --no-modify-path --default-toolchain stable
