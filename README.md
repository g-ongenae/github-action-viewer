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

## Trying it against GitHub

Until the server lands, `pnpm run snapshot` collects the page once from the live API and prints
it, one line per branch or pull request, followed by the number of requests it took and the
remaining API quota. `pnpm run snapshot --json` prints the whole result as JSON instead.

It reads `config.json` from the repository root if there is one (the defaults otherwise), and
uses the first token found among:

1. the `GITHUB_TOKEN` environment variable,
2. the `GH_TOKEN` environment variable,
3. `gh auth token` (the [GitHub CLI](https://cli.github.com/)'s login).

The token only needs to read: the tool sends nothing but `GET` requests. With a fine-grained token,
grant read access to _Metadata_, _Pull requests_ and _Actions_ on the repositories to watch.

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
| `pnpm snapshot`      | Collect once from the live GitHub API and print it     |
