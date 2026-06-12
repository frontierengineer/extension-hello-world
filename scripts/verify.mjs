// verify.mjs — prove the example COMPILES and BUNDLES, exactly as the host would.
//
// The catch: every capability imports the contract as `../../types` — the
// specifier real (installed) extensions use. In the host, an extension lives at
// <FRONTIER_DIR>/extensions/<id>/, so `../../types` resolves to the host-written
// extensions/types.ts one level ABOVE the extension. This repo is a FLAT
// standalone extension (extension.json at the root), so `../../` from a
// capability would escape above the repo — there is no real file there to
// typecheck against, and TypeScript will not remap a relative specifier.
//
// So we reproduce the production directory shape in a temp mirror:
//
//     .verify/
//       types.ts            (← the repo's vendored host contract, as a sibling —
//       workspaceTypes.ts      mirrors extensions/types.ts the host writes)
//       hello-world/        (← a symlink to this repo = the <id> dir)
//
// `../../types` (the HOST contract) resolves up to .verify/types.ts — the
// production position. `../messages` (the extension's OWN root file) resolves
// INSIDE the repo, one level up from a capability — so messages.ts is NOT a
// sibling here; it ships with the extension. IDENTICAL to how the host resolves
// both. We run tsc from
// there (host-side + ui), then esbuild every entry the way the bundler does.
// The mirror is throwaway (.gitignored); the committed source stays a clean,
// flat, production-faithful extension.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mirror = path.join(root, '.verify');
const id = 'hello-world';

function run(label, file, args) {
  process.stdout.write(`• ${label} … `);
  try {
    execFileSync(file, args, { cwd: root, stdio: 'pipe' });
    console.log('OK');
  } catch (err) {
    console.log('FAILED');
    process.stderr.write((err.stdout?.toString() || '') + (err.stderr?.toString() || '') + '\n');
    process.exitCode = 1;
  }
}

// ── Build the production-shaped mirror ─────────────────────────────────────
fs.rmSync(mirror, { recursive: true, force: true });
fs.mkdirSync(mirror, { recursive: true });
// The vendored HOST contract becomes a sibling of the <id> dir (where the host
// writes its types shim), so `../../types` from a nested capability resolves to
// it. (messages.ts is the extension's OWN file, reached via `../messages` from
// inside the repo — not a sibling.) workspaceTypes.ts rides along because the
// vendored types.ts imports it with `./workspaceTypes`.
for (const f of ['types.ts', 'workspaceTypes.ts']) {
  fs.symlinkSync(path.join(root, f), path.join(mirror, f));
}
// The <id> dir IS this repo.
fs.symlinkSync(root, path.join(mirror, id), 'dir');

// A tsconfig that typechecks the host-side halves from inside the mirror, so
// `../../types` resolves to .verify/types.ts (the production position).
const hostTsconfig = path.join(mirror, 'tsconfig.host.json');
fs.writeFileSync(hostTsconfig, JSON.stringify({
  extends: `./${id}/tsconfig.json`,
  include: [
    `${id}/server/**/*.ts`, `${id}/worker/**/*.ts`,
    `${id}/mcp/**/*.ts`, `${id}/hooks/**/*.ts`,
  ],
}, null, 2));

const uiTsconfig = path.join(mirror, 'tsconfig.ui.json');
fs.writeFileSync(uiTsconfig, JSON.stringify({
  extends: `./${id}/ui/tsconfig.json`,
  include: [`${id}/ui/index.tsx`],
}, null, 2));

const tsc = path.join(root, 'node_modules', '.bin', 'tsc');

// ── Run the checks ─────────────────────────────────────────────────────────
console.log('Verifying hello-world (production-nested mirror in .verify/):\n');
run('typecheck  host-side (server/worker/mcp/hooks)', tsc, ['--noEmit', '-p', hostTsconfig]);
run('typecheck  ui (browser)', tsc, ['--noEmit', '-p', uiTsconfig]);
run('bundle     all entries (esbuild, host settings)', process.execPath, [path.join(root, 'scripts', 'build-check.mjs')]);

fs.rmSync(mirror, { recursive: true, force: true });
console.log(process.exitCode ? '\nVERIFY FAILED' : '\nVERIFY OK — compiles and bundles.');
