# github-action-viewer

A small local web page that shows, in real time, the GitHub Actions runs I care about:

- runs linked to my open pull requests (in any repository),
- runs in my own repositories,
- runs in repositories I maintain (an editable list).

> Work in progress — the project is being built up through a series of pull requests.

## Development

Requirements: Node.js 24 (`engines.node` in [`package.json`](package.json), also read by CI) and npm.

```sh
npm ci          # install dependencies from the lockfile
npm run check   # run every gate CI runs
```

| Script                  | What it does                                           |
| ----------------------- | ------------------------------------------------------ |
| `npm run build`         | Compile `src/` to `dist/` with `tsc`                   |
| `npm run typecheck`     | Type-check sources, tests and config files             |
| `npm run lint`          | ESLint (type-aware); `lint:fix` applies safe fixes     |
| `npm run format`        | Format everything with Prettier                        |
| `npm run format:check`  | Fail if a file is not Prettier-formatted               |
| `npm test`              | Run the Vitest suite once                              |
| `npm run test:watch`    | Run Vitest in watch mode                               |
| `npm run test:coverage` | Run the tests with V8 coverage (report in `coverage/`) |
| `npm run check`         | `format:check`, `lint`, `typecheck`, `test`, `build`   |
