# github-action-viewer

A small local web page that shows, in real time, the GitHub Actions runs I care about:

- runs linked to my open pull requests (in any repository),
- runs in my own repositories,
- runs in repositories I maintain (an editable list).

> Work in progress — the project is being built up through a series of pull requests.

## Development

Requirements:

- Node.js 26: the version CI uses is in [`.node-version`](.node-version), which `fnm use` /
  `nvm use` also read. `package.json#engines` accepts `^26.0.0`, and `pnpm install` refuses other
  versions.
- pnpm 12: the exact version is pinned in `package.json#packageManager`. Any recent pnpm switches
  to it automatically.

```sh
pnpm install    # install dependencies from the lockfile
pnpm run check  # run every gate CI runs
```

| Script               | What it does                                           |
| -------------------- | ------------------------------------------------------ |
| `pnpm build`         | Compile `src/` to `dist/` with `tsc`                   |
| `pnpm typecheck`     | Type-check sources, tests and config files             |
| `pnpm lint`          | ESLint (type-aware); `lint:fix` applies safe fixes     |
| `pnpm format`        | Format everything with Prettier                        |
| `pnpm format:check`  | Fail if a file is not Prettier-formatted               |
| `pnpm test`          | Run the Vitest suite once                              |
| `pnpm test:watch`    | Run Vitest in watch mode                               |
| `pnpm test:coverage` | Run the tests with V8 coverage (report in `coverage/`) |
| `pnpm check`         | `format:check`, `lint`, `typecheck`, `test`, `build`   |
