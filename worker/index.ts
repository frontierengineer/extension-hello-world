// ═══════════════════════════════════════════════════════════════════════════
//  worker/index.ts — NEXT TO THE FILES
// ═══════════════════════════════════════════════════════════════════════════
//
//  REALM: worker (the worker-side bundle). The host bundles this to a node
//  CJS module and EVERY connected worker daemon fetches + require()s + registers
//  it on connect — so this code runs ON THE WORKER, next to its files, not in
//  the host. There are no browser globals and no DOM here: Node built-ins are
//  available directly, and paths are the worker's real paths. Like the surface
//  and host realms, register() is declaration-only. The worker realm takes
//  THREE kinds of top-level component, mirroring the surface realm's
//  application/sidebar/daemon: an agent RUNTIME (w.runtime.register), WORKSPACE
//  definitions (w.workspace.register), and the general-purpose DAEMONS
//  (w.daemons.register). Hello World contributes only a daemon; each component's
//  mount() receives its own flat context (WorkerDaemonContext here) and its
//  logic lives inside.
//
//  KEY RULE — this bundle has exactly ONE peer, and it is the extension's HOST
//  bundle. There is no window and no way to address a surface: `context.host` is
//  a connection to host/index.ts and nothing else. So making something appear in
//  the UI is a two-leg trip — publish to the host bundle, and the host bundle
//  re-publishes to its surfaces (host/index.ts §8). This file shows both
//  directions of that one connection:
//    • it ANSWERS the host bundle's inspect request (host.respond — the platform
//      owns the correlation and the timeout), and
//    • it PUSHES an unsolicited heartbeat to the host bundle (host.publish —
//      fire-and-forget, the streaming half).
//
//  Node built-ins (fs/os) are imported normally — esbuild keeps them external in
//  the node CJS bundle. (context.modules is the daemon-located loader for
//  modules that are NOT bundled — worker-installed packages like node-pty or an
//  agent SDK; unused here, node built-ins are all we need.) `../../types` is
//  type-only and erased.

import * as fs from 'fs';
import * as os from 'os';
import type { WorkerProvider, WorkerDaemonContext } from '../../types';
import type { WorkerInspectReply } from '../messages';

const HEARTBEAT_MS = 30_000; // push a heartbeat to the host bundle twice a minute
const MAX_ENTRIES = 20;      // cap the directory listing we send back

export function register(provider: WorkerProvider): void {
  const w = provider.version(1);
  // register() is declaration-only: it names the one component this worker
  // bundle contributes (a daemon, with its manifest-declared id; a runtime or
  // a workspace would be registered here at the top level the same way).
  // Everything below lives inside the daemon's mount().
  w.daemons.register({ id: 'hello-world', mount });
}

// The hello-world worker daemon. Its mount() receives the flat
// WorkerDaemonContext: `host` is this bundle's one connection (to the
// extension's host bundle) and the rest (actions, execute, modules, hostUrl)
// sits flat beside it (unused here — this component needs only node built-ins).
// mount returns the component's teardown as `dispose`.
function mount(context: WorkerDaemonContext): { dispose?: () => void } {
  const { host } = context;

  // ── Inspect this worker — something only code beside the files can do ──────
  // Read the hostname, the cwd, and a short listing of that directory. The
  // daemon's cwd is the worker's working area, so this proves the code is
  // genuinely running out there, not in the host process.
  function inspect(): WorkerInspectReply {
    const cwd = process.cwd();
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(cwd).slice(0, MAX_ENTRIES);
    } catch (err: any) {
      entries = [`<unreadable: ${err?.message || err}>`];
    }
    return {
      hostname: os.hostname(),
      platform: process.platform,
      cwd,
      entries,
    };
  }

  // ── Direction 1: ANSWER the host bundle's request ───────────────────────────
  // host/index.ts §8 calls `host.request('inspect', { worker })`; the responder
  // registered here returns the answer and the PLATFORM carries it back to the
  // awaiting promise — the correlation and the timeout are the connection's job,
  // so neither side mints request ids or matches replies by hand. The handler
  // receives the payload only: there is no envelope to read and no sender to
  // disambiguate, because this connection has exactly one peer. Throwing here is
  // correct for an unexpected fault — the shared boundary reports it once and
  // rejects the host bundle's `request`, so nothing is silently dropped. A
  // respond() for a type is a per-type upsert across the extension's daemons on
  // this worker.
  host.respond('inspect', () => inspect());

  // The same liveness fact, ANSWERABLE on demand. The push below is on our
  // schedule, not the host bundle's, so a host bundle that has just loaded would
  // otherwise have to wait out an interval it does not control before it knew
  // anything. Anything a daemon streams should also be askable.
  host.respond('beat', () => ({ hostname: os.hostname(), at: new Date().toISOString() }));

  // ── Direction 2: PUSH unsolicited heartbeats to the host bundle ─────────────
  // Nothing asked for these. The daemon decides on its own to report it is
  // alive, and the publish goes to its one peer: the host bundle, whose
  // 'heartbeat' subscriber knows which connection spoke and re-publishes to the
  // surfaces with our worker id folded in. We do NOT name ourselves in the
  // payload — the hub is the honest source of that fact. A publish while the
  // connection is down is dropped with a log rather than queued (it is live
  // signaling, not a mailbox), so a brief disconnect is harmless: the next beat
  // carries the same information.
  function beat(): void {
    host.publish('heartbeat', { hostname: os.hostname(), at: new Date().toISOString() });
  }

  beat(); // one immediately on connect, so a UI sees life right away
  const timer = setInterval(beat, HEARTBEAT_MS);

  // The host can't see our interval — clean it up ourselves on unload. This is
  // the daemon's `dispose`, returned from mount: the single unload hook, the same
  // shape all three realms use.
  return { dispose: () => clearInterval(timer) };
}
