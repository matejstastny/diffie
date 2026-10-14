#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="$HOME/.local/bin"
applications_dir="$HOME/.local/share/applications"
icon_dir="$HOME/.local/share/icons/hicolor/512x512/apps"

printf '%s\n' "Building Diffie..."
cd "$project_dir"
pnpm install --frozen-lockfile --silent
pnpm --silent run build >/dev/null
cargo build --release --quiet --features custom-protocol --manifest-path "$project_dir/src-tauri/Cargo.toml"

printf '%s\n' "Installing Diffie..."
install -Dm755 "$project_dir/src-tauri/target/release/diffie" "$bin_dir/diffie"
install -Dm644 "$project_dir/src-tauri/icons/icon.png" "$icon_dir/diffie.png"
mkdir -p "$applications_dir"
sed "s|@DIFFIE_BIN@|$bin_dir/diffie|g" "$project_dir/packaging/diffie.desktop" >"$applications_dir/diffie.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$applications_dir" >/dev/null 2>&1 || true
fi

printf '%s\n' "Done. Run diffie or open Diffie from your app launcher."
