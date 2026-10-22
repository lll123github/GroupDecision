#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_HOME="$PWD/.toolchain/cargo"
export RUSTUP_HOME="$PWD/.toolchain/rustup"
export TMPDIR="$PWD/.tmp"
export PATH="$CARGO_HOME/bin:$PATH"
mkdir -p "$TMPDIR"
cargo build --release --locked -j 2
node --check static/app.js
