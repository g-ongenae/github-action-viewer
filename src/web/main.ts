// Entry point of the page, loaded by index.html as a module.

import { App } from './app.ts';
import { Connection } from './connection.ts';
import { createWatchListApi } from './watch-list-api.ts';

const TICK_MS = 1000;

interface HostedView {
  readonly view: string;
  readonly installationUrl: string;
}

function goToSignIn(): void {
  document.body.replaceChildren();
  location.replace('/');
}

function start(hosted?: HostedView): void {
  const withView = (url: string): string =>
    hosted ? `${url}?view=${encodeURIComponent(hosted.view)}` : url;

  const app = hosted
    ? new App(
        document,
        Date.now,
        createWatchListApi(async (url, init) => {
          const response = await fetch(withView(url), init);
          if (response.status === 401) {
            signIn();
          }
          return response;
        }),
        null,
      )
    : new App(document);

  let checking = false;

  function signIn(): void {
    connection.stop();
    clearInterval(tick);
    goToSignIn();
  }

  async function checkSession(): Promise<void> {
    if (checking) {
      return;
    }
    checking = true;
    try {
      const response = await fetch(withView('/auth/session'), { cache: 'no-store' });
      if (response.status === 401) {
        signIn();
      }
    } catch {
      // The stream watchdog retries connectivity failures.
    } finally {
      checking = false;
    }
  }

  const connection = new Connection({
    url: withView('/api/events'),
    onPayload: (payload) => {
      app.setPayload(payload);
    },
    onHeartbeat: (heartbeat) => {
      app.applyHeartbeat(heartbeat);
    },
    onStateChange: (state) => {
      app.setConnection(state);
    },
    ...(hosted
      ? {
          onAuthRequired: signIn,
          onError: () => {
            void checkSession();
          },
        }
      : {}),
  });

  if (hosted) {
    const controls = document.getElementById('account-controls');
    const link = document.querySelector<HTMLAnchorElement>('#install-app');
    const button = document.querySelector<HTMLButtonElement>('#sign-out');
    const status = document.getElementById('sign-out-status');
    if (link) {
      link.href = hosted.installationUrl;
      link.hidden = false;
    }
    if (controls && button && status) {
      controls.hidden = false;
      button.addEventListener('click', () => {
        button.disabled = true;
        status.textContent = '';
        void fetch(withView('/auth/logout'), { method: 'POST' })
          .then((response) => {
            if (!response.ok && response.status !== 401) {
              throw new Error('Sign-out failed.');
            }
            signIn();
          })
          .catch(() => {
            status.textContent = 'Could not sign out. Try again.';
            button.disabled = false;
          });
      });
    }
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        location.reload();
      }
    });
    window.addEventListener('pagehide', () => {
      connection.stop();
      clearInterval(tick);
      document.body.replaceChildren();
    });
  }

  connection.start();
  const tick = setInterval(() => {
    app.render();
  }, TICK_MS);
}

async function startHosted(): Promise<void> {
  const response = await fetch('/auth/session', { cache: 'no-store' });
  if (response.status === 401) {
    goToSignIn();
    return;
  }
  const data: unknown = await response.json();
  if (
    !response.ok ||
    !data ||
    typeof data !== 'object' ||
    !('view' in data) ||
    typeof data.view !== 'string' ||
    !('installationUrl' in data) ||
    typeof data.installationUrl !== 'string'
  ) {
    throw new Error('Hosted session unavailable.');
  }
  start({ view: data.view, installationUrl: data.installationUrl });
}

if (location.pathname === '/dashboard') {
  void startHosted().catch(() => {
    const status = document.getElementById('status');
    if (status) {
      status.textContent = 'Could not load your session. Reload to try again.';
    }
  });
} else {
  start();
}
