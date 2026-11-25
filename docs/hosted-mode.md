# Hosted GitHub Actions Viewer

Local startup keeps using the token configured by the operator. The hosted entry point
requires each visitor to connect with GitHub and uses that visitor's GitHub App user
access token for collection. Browser tabs with the same session can share collection
work. Different sessions have separate snapshots, watch lists, caches and event streams.

## Pull request sequence

1. Introduce request-scoped data routing and event streams. Keep the local entry
   point and demo on the existing single-source setup. Test isolation with two
   simultaneous streams and revocation with a stream open.
2. Add a hosted entry point with GitHub authorization-code exchange, PKCE and
   one-time state, opaque sessions, token rotation, bounded per-session pollers,
   and sign-in and sign-out controls. Preserve the local collector's behavior and
   apply a shorter, permission-aware snapshot policy in hosted mode. Document setup
   and test with a simulated GitHub API.

## Deployment and acceptance

Run a single Node service on loopback behind an HTTPS proxy that forwards server-sent
events without buffering. Register a GitHub App with Actions and Pull requests
read access, Metadata read access, and expiring user tokens. Organization approval
may be needed to install the app on private repositories. The browser only receives
a session cookie. The initial deployment keeps sessions and watch lists in memory,
so a restart requires signing in again and recreating watch lists.

Before public deployment, verify real GitHub authorization and discovery with two
accounts that have different private repository access. Check public repositories,
organization installations, token expiry, logout across tabs, and repository access
removed during a live session. Account changes must clear the dashboard and its
browser-side preferences.

## Configure the hosted service

1. Register a GitHub App with the callback URL
   `https://viewer.example.com/auth/callback`, expiring user access tokens, and the
   permissions listed above. Allow installations by other accounts if the service
   is for visitors outside the App owner's account. Sign-in and repository
   installation are separate steps.
2. Set `VIEWER_PUBLIC_ORIGIN=https://viewer.example.com`, `GITHUB_APP_CLIENT_ID`,
   `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_SLUG` (the name in the App's GitHub
   URL). Store the secret in the host's secret configuration. Start with
   `pnpm start:hosted`. The default loopback port is 4680 and can be set with
   `PORT`.
3. Proxy the public HTTPS origin to the Node service, preserving the public
   `Host` header (including any non-default port). Bypass response caching for
   `/dashboard`, `/auth/*`, and `/api/*`. Forward `/api/events` unbuffered with
   an idle timeout above the 15-second heartbeat. Keep OAuth callback query
   strings, cookies, and authorization headers out of proxy logs.

If a private repository is missing, use **Connect repositories** to install or
configure the App for that repository, then reopen the dashboard. The token can
read private repositories only when both the visitor and the App have access.
