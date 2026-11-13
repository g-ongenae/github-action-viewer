// `pnpm run build:web`: copies the page's static files from src/web/ to dist/web/, the directory
// the server serves. TypeScript sources are skipped: compiling them is the page's own build step.

import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../src/web/', import.meta.url));
const target = fileURLToPath(new URL('../../dist/web/', import.meta.url));

await rm(target, { recursive: true, force: true });
await cp(source, target, {
  recursive: true,
  filter: (path) => !path.endsWith('.ts'),
});
