// `pnpm dev`: the server and the page, rebuilt as their sources change. Runs three things at once
// and stops them together:
//
// - `tsc --watch` on the page's modules (src/web/*.ts → dist/web/modules/);
// - a watcher copying the page's static files (HTML, CSS, icons) to dist/web/ when they change;
// - the server under `node --watch`, restarted when one of its modules changes.
//
// Reload the browser tab to see a change to the page. Arguments go to the server, e.g.
// `pnpm dev --demo`.

import { spawn, type ChildProcess } from 'node:child_process';
import { watch } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { copyWebFiles, isStaticWebFile, WEB_SOURCE } from './build-web.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

await copyWebFiles({ clean: true });

const children: ChildProcess[] = [
  spawn(
    process.execPath,
    [tsc, '-p', 'src/web/tsconfig.build.json', '--watch', '--preserveWatchOutput'],
    { cwd: root, stdio: 'inherit' },
  ),
  spawn(process.execPath, ['--watch', 'src/server/main.ts', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
  }),
];

let copyTimer: ReturnType<typeof setTimeout> | undefined;
const watcher = watch(WEB_SOURCE, { recursive: true }, (_event, file) => {
  if (file !== null && isStaticWebFile(file)) {
    // Editors write several events per save: copy once they settle.
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyWebFiles({ clean: false }).then(
        () => {
          process.stdout.write(`[dev] Copied the page's static files (${file}).\n`);
        },
        (error: unknown) => {
          process.stderr.write(`[dev] Could not copy the page's files: ${String(error)}\n`);
        },
      );
    }, 100);
  }
});

let stopping = false;
function stop(code: number): void {
  if (stopping) {
    return;
  }
  stopping = true;
  watcher.close();
  for (const child of children) {
    child.kill('SIGINT');
  }
  process.exitCode = code;
}
for (const child of children) {
  child.on('exit', (code) => {
    stop(code ?? 0);
  });
}
process.on('SIGINT', () => {
  stop(0);
});
process.on('SIGTERM', () => {
  stop(0);
});
