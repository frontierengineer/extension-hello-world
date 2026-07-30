#!/usr/bin/env node
// Typecheck this extension against the REAL host contract.
//
//   node typecheck.mjs                       # frontier checkout at ../frontier
//   FRONTIER_REPO=/path/to/frontier node typecheck.mjs
//
// WHY IT STAGES INSTEAD OF JUST RUNNING tsc HERE
//   Every realm imports the contract as '../../types' — two levels up from a
//   realm directory — because that is where it lives once installed: the host
//   writes `extensions/types.ts` as a SIBLING of every installed extension
//   directory (README → "How types resolve"). That specifier is relative, so no
//   tsconfig `paths` entry can redirect it; the only way to typecheck the code
//   exactly as it ships is to put it in that layout. So this script reproduces
//   the installed layout in a temp directory —
//
//     <stage>/extensions/types.ts        re-exports the checkout's contract
//     <stage>/extensions/hello-world/    a copy of this repo's TS sources
//
//   — and runs `tsc --noEmit` over each realm there. Nothing is vendored into
//   this repo, so the check can never pass against a stale copy of the contract:
//   it always reads the one in the checkout you point it at.
//
// WHAT IT BORROWS FROM THE CHECKOUT
//   The contract (interfaces/extension.ts), a tsc, node's @types, and — for the
//   surface realm — React's @types plus the shared UI kit the host aliases as
//   @frontierengineer/ui. An extension is not npm-installed on its own, exactly
//   as in the host's own extension typecheck.

import { existsSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const REPO = dirname(fileURLToPath(import.meta.url));
const FRONTIER = process.env.FRONTIER_REPO || join(REPO, '..', 'frontier');

function need(path, what) {
  if (!existsSync(path)) {
    console.error(`missing ${what}: ${path}`);
    console.error('point FRONTIER_REPO at a frontier checkout with its host + frontend deps installed.');
    process.exit(1);
  }
  return path;
}

const CONTRACT = need(join(FRONTIER, 'interfaces/extension.ts'), 'the extension contract');
const TSC = need(join(FRONTIER, 'host/node_modules/typescript/bin/tsc'), 'a typescript compiler');
const NODE_TYPES = need(join(FRONTIER, 'host/backend/node_modules/@types'), "node's @types");
const FRONTEND = need(join(FRONTIER, 'surface-electron/frontend'), 'the host frontend tree');
const FRONTEND_TYPES = need(join(FRONTEND, 'node_modules/@types'), "the frontend's @types");
const UI_KIT = need(join(FRONTEND, 'src/ui'), 'the shared UI kit');
const HOST_CONTRACT_SHIM = need(join(FRONTIER, 'host/backend/extensions/types.ts'), 'the @extension-types shim');

// ── stage the installed layout ──────────────────────────────────────────────
const stage = mkdtempSync(join(tmpdir(), 'hello-world-typecheck-'));
process.on('exit', () => { try { rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ } });

const extensions = join(stage, 'extensions');
const ext = join(extensions, 'hello-world');
for (const d of ['host', 'worker', 'surface']) mkdirSync(join(ext, d), { recursive: true });

// The sibling shim, exactly as the host writes it next to an installed extension.
writeFileSync(join(extensions, 'types.ts'), `export * from '${CONTRACT.replace(/\.ts$/, '')}';\n`);

const sources = [
  'messages.ts',
  'host/index.ts',
  'worker/index.ts',
  'surface/index.tsx',
];
for (const rel of sources) copyFileSync(join(REPO, rel), join(ext, rel));

// ── one tsconfig per realm, mirroring how each realm is really compiled ─────
// host/ and worker/ are node CommonJS bundles; surface/ is a browser ESM bundle
// with JSX and the extension's own React.
const shared = {
  target: 'ES2022',
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  noEmit: true,
};

const configs = {
  host: {
    compilerOptions: {
      ...shared,
      module: 'CommonJS',
      moduleResolution: 'node',
      lib: ['ES2022'],
      types: ['node'],
      typeRoots: [NODE_TYPES],
    },
    include: ['extensions/hello-world/host/index.ts'],
  },
  worker: {
    compilerOptions: {
      ...shared,
      module: 'CommonJS',
      moduleResolution: 'node',
      lib: ['ES2022'],
      types: ['node'],
      typeRoots: [NODE_TYPES],
    },
    include: ['extensions/hello-world/worker/index.ts'],
  },
  surface: {
    compilerOptions: {
      ...shared,
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      baseUrl: '.',
      typeRoots: [FRONTEND_TYPES],
      paths: {
        // The specifiers the host's esbuild aliases at bundle time, pointed at
        // the same files it points them at.
        '@frontierengineer/ui': [join(UI_KIT, 'index.tsx')],
        '@frontierengineer/ui/*': [join(UI_KIT, '*')],
        '@extension-types': [HOST_CONTRACT_SHIM],
        react: [join(FRONTEND_TYPES, 'react')],
        'react/*': [join(FRONTEND_TYPES, 'react/*')],
        'react-dom': [join(FRONTEND_TYPES, 'react-dom')],
        'react-dom/*': [join(FRONTEND_TYPES, 'react-dom/*')],
      },
    },
    include: ['extensions/hello-world/surface/index.tsx'],
  },
};

for (const [realm, config] of Object.entries(configs)) {
  writeFileSync(join(stage, `tsconfig.${realm}.json`), JSON.stringify(config, null, 2));
}

// ── run them ────────────────────────────────────────────────────────────────
function run(realm) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSC, '--noEmit', '-p', join(stage, `tsconfig.${realm}.json`)], {
      cwd: stage,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ realm, ok: code === 0, out: out.trim() }));
  });
}

const results = [];
for (const realm of Object.keys(configs)) results.push(await run(realm));

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`OK   ${r.realm}/`);
  } else {
    failed++;
    console.error(`FAIL ${r.realm}/`);
    // Paths in the output point into the stage; rewrite them back to this repo
    // so an error is clickable where the source actually lives.
    for (const line of r.out.split('\n')) console.error(`  ${line.split(`${ext}/`).join('')}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} realms clean (contract: ${CONTRACT})`);
process.exit(failed ? 1 : 0);
