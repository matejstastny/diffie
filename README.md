# diffie

A focused, read-only Git branch diff viewer for Linux.

## Run locally

```sh
pnpm install
pnpm build
cd src-tauri && cargo run --release --features custom-protocol -- /path/to/repository
```

For development, run `pnpm dev` in one terminal and `cargo run -- /path/to/repository` from `src-tauri` in another.

You can also choose a repository folder in the app, paste its path, or open a recent repository with `Ctrl+P` or `Cmd+P`.

## Scope

Diffie compares local and remote branches from their merge base, or a branch against the local checkout. It presents changed files in a status tree, renders selected files in a virtualized side-by-side diff, and supports a whole-file view with syntax highlighting. It intentionally does not edit files, stage changes, or connect to hosting services.

## Development

Use `pnpm verify` before opening a pull request. It runs formatting, linting, TypeScript checks, Rust formatting, Clippy, and tests. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow and release process.

## License

[MIT](LICENSE)
