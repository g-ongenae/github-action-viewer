# github-action-viewer

A small local web page that shows, in real time, the GitHub Actions runs I care about:

- runs linked to my open pull requests (in any repository),
- runs in my own repositories,
- runs in repositories I maintain (an editable list).

> Work in progress — the project is being built up through a series of pull requests.

## Configuration

The viewer reads a `config.json` file. Every key is optional; [`config.example.json`](config.example.json)
lists them all with their defaults. Unknown keys are rejected (they are usually typos), and every
problem is reported at once with the key at fault. Repository names are written `owner/name` and
compared case-insensitively.

| Key                               | Default | Meaning                                                                                                                           |
| --------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `maintainedRepositories`          | `[]`    | Repositories to watch in addition to your own, e.g. `["example-org/example-service"]`.                                            |
| `excludedRepositories`            | `[]`    | Repositories never shown, even if you own them, maintain them or have a pull request there.                                       |
| `includeOwnRepositories`          | `true`  | Watch the repositories you own.                                                                                                   |
| `ownRepositoriesPushedWithinDays` | `30`    | Only watch your own repositories pushed to within this many days (an integer ≥ 1), to skip dormant ones; `null` watches them all. |
| `includeMyPullRequests`           | `true`  | Watch every repository where you have an open pull request, showing only your pull requests there.                                |
| `recentWindowHours`               | `24`    | How long finished runs of other branches and other people's pull requests stay on the page (a number ≥ 0).                        |
| `pollIntervalSeconds`             | `15`    | Time between two refreshes from GitHub, in whole seconds (at least 10).                                                           |
| `port`                            | `4680`  | Port of the local server (bound to `127.0.0.1`).                                                                                  |

In a repository you own or maintain, the page always shows the default branch and your open pull
requests; other branches and other people's pull requests appear while their runs are active and
for `recentWindowHours` after they finish.

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
