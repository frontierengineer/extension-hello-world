// build-check.mjs — esbuild every entry the way the Frontier host does, to
// prove the example actually bundles before publishing. Mirrors the host's
// backend/extensions/bundler.ts:
//   • ui/index.tsx        → browser ESM, jsx automatic (react/react-dom marked
//                           external here so the check needs no vendored copy;
//                           the host pins them to ui/node_modules instead).
//   • server|worker|mcp|hooks/index.ts → node CJS (node built-ins external;
//                           type-only `../../types` imports are erased).
//
// Capabilities import the contract as `../../types` (the production specifier).
// esbuild won't alias a relative key, and in a flat repo `../../` escapes above
// the root — so we resolve entries through the SAME production-nested mirror
// verify.mjs builds (.verify/hello-world/<cap>/index.ts), where `../../types`
// points at a real sibling file. ensureMirror() builds it if it's not already
// there (so this script also runs standalone).
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mirror = path.join(root, '.verify');
const id = 'hello-world';
const extDir = path.join(mirror, id);

// Build the production-shaped mirror if verify.mjs hasn't already (idempotent):
// vendored contract files as siblings of an <id> dir that symlinks the repo.
function ensureMirror() {
  if (fs.existsSync(extDir)) return false; // already built by caller
  fs.mkdirSync(mirror, { recursive: true });
  // Host contract as siblings (where the host writes its types shim); the
  // extension's own messages.ts is reached via `../messages` inside the repo.
  for (const f of ['types.ts', 'workspaceTypes.ts']) {
    fs.symlinkSync(path.join(root, f), path.join(mirror, f));
  }
  fs.symlinkSync(root, extDir, 'dir');
  return true; // we own it → clean it up
}

const browserEntry = { entry: 'ui/index.tsx', label: 'ui (browser)' };
const nodeEntries = [
  { entry: 'server/index.ts', label: 'server (node)' },
  { entry: 'worker/index.ts', label: 'worker (node)' },
  { entry: 'mcp/index.ts', label: 'mcp (node)' },
  { entry: 'hooks/index.ts', label: 'hooks (node)' },
];

async function buildBrowser() {
  await esbuild.build({
    entryPoints: [path.join(extDir, browserEntry.entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    preserveSymlinks: true, // resolve `../../types` against the mirror, not the symlink target
    // The host pins these to the capability's own node_modules; for a pure
    // resolution/syntax check we mark them external so no install is required.
    external: ['react', 'react-dom', 'react-dom/client', '@frontierengineer/ui'],
    logLevel: 'silent',
  });
  console.log(`OK  ${browserEntry.label}`);
}

async function buildNode({ entry, label }) {
  await esbuild.build({
    entryPoints: [path.join(extDir, entry)],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node16',
    preserveSymlinks: true,
    logLevel: 'silent',
  });
  console.log(`OK  ${label}`);
}

const owned = ensureMirror();
try {
  await buildBrowser();
  for (const e of nodeEntries) await buildNode(e);
  console.log('\nAll entries bundle cleanly.');
} catch (err) {
  console.error('\nbuild-check FAILED:\n', err.message || err);
  process.exitCode = 1;
} finally {
  if (owned) fs.rmSync(mirror, { recursive: true, force: true });
}
