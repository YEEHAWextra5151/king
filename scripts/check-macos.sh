#!/usr/bin/env bash
# Type-checks the Rust side (including the objc2/AppKit glue) for both Apple
# architectures from any host. Only objc2-exception-helper compiles C; it has
# no system headers, so a plain clang can build it without the macOS SDK.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target add "$target" >/dev/null 2>&1 || true
  var="CC_${target//-/_}"
  export "$var"="${!var:-clang}"
  ar_var="AR_${target//-/_}"
  export "$ar_var"="${!ar_var:-llvm-ar}"
  echo "▸ cargo check --target $target"
  cargo check --target "$target" --all-targets
done
