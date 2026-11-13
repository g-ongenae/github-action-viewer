// `pnpm run build:web` (first step): clears dist/web/, the directory the server serves, and copies
// the page's static files from src/web/ into it. TypeScript sources and tsconfig files are
// skipped: `tsc -p src/web/tsconfig.build.json`, the second step, compiles the page's modules to
// dist/web/modules/.

import { cp, mkdir, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB_SOURCE = fileURLToPath(new URL('../../src/web/', import.meta.url));
export const WEB_TARGET = fileURLToPath(new URL('../../dist/web/', import.meta.url));

/** Whether a file of src/web/ is served as-is (HTML, CSS, images), not compiled or ignored. */
export function isStaticWebFile(path: string): boolean {
  return !path.endsWith('.ts') && !/^tsconfig.*\.json$/.test(basename(path));
}

/** Copies the static files of src/web/ to dist/web/; `clean` empties dist/web/ first. */
export async function copyWebFiles({ clean }: { readonly clean: boolean }): Promise<void> {
  if (clean) {
    await rm(WEB_TARGET, { recursive: true, force: true });
  }
  await mkdir(WEB_TARGET, { recursive: true });
  await cp(WEB_SOURCE, WEB_TARGET, { recursive: true, filter: isStaticWebFile });
}

if (import.meta.main) {
  await copyWebFiles({ clean: true });
}
