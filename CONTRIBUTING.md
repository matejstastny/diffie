# Contributing to Diffie

## Requirements

- Node.js 22 or newer
- pnpm 11
- Rust stable with `clippy` and `rustfmt`
- The Linux dependencies required by Tauri

## Everyday commands

```sh
pnpm dev
pnpm check
pnpm lint
pnpm format
pnpm test
pnpm verify
```

`pnpm verify` is the same validation used in CI. The Git hooks format staged
web files and Rust files before a commit, then require a Conventional Commit
message such as `feat: add remote branch filters`.

## Releases

Keep the version in `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json` in sync. Push a matching tag such as `v0.2.0` to
build draft Linux AppImage and Debian packages in GitHub Actions.
