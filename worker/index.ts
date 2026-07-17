// ═══════════════════════════════════════════════════════════════════════════
//  worker/index.ts — NEXT TO THE FILES
// ═══════════════════════════════════════════════════════════════════════════
//
//  REALM: worker (the daemon-side bundle). The host bundles this to a node
//  CJS module and EVERY connected worker daemon fetches + require()s + registers
//  it on connect — so this code runs ON THE MACHINE, next to its files, not in
//  the host. Like the surface and host realms, register() is declaration-only.
//  The worker realm takes THREE kinds of top-level component, mirroring the
//  surface realm's application/sidebar/daemon: an agent RUNTIME
//  (w.runtime.register), WORKSPACE kinds (w.workspace.register), and the
//  general-purpose DAEMONS (w.daemons.register). Hello World contributes only a
//  daemon; each component's mount() receives its own flat context
//  (WorkerDaemonContext here) and its logic lives inside.
//
//  KEY RULE — a worker reaches the UI by going THROUGH its host bundle. A worker
//  component has NO bus and NO window; the only thing it can talk to is its own
//  host/ code, over the extension's one bus. To make something appear in the UI it publishes to
//  the host bundle, and the host bundle re-publishes it on the bus to the UIs (see
//  host/index.ts §8). This file shows both halves of that:
//    • it ANSWERS a caller's targeted inspect request (bus.extension.respond — the
//      platform owns the correlation and the timeout), and
//    • it PUSHES an unsolicited heartbeat every bus subscriber receives
//      (bus.extension.publish — fire-and-forget, the streaming half).
//
//  Node built-ins (fs/os/path) are imported normally — esbuild keeps them
//  external in the node CJS bundle. (context.modules is the daemon-located
//  loader for modules that are NOT bundled — machine-installed packages like
//  node-pty or an agent SDK; unused here, node built-ins are all we need.)
//  `../../types` is type-only and erased.

import * as fs from 'fs';
import * as os from 'os';
import type { WorkerProvider, WorkerDaemonContext } from '../../types';
import type { WorkerHeartbeat, WorkerInspectReply } from '../messages';

const HEARTBEAT_MS = 30_000; // publish a heartbeat on the bus twice a minute
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
// WorkerDaemonContext: `bus` is the extension's ONE bus — the same shape every
// realm holds — and the rest (actions, execute, modules, hostUrl) sits flat
// beside it (unused here — this component needs only node built-ins). mount
// returns the component's teardown as `dispose`.
function mount(context: WorkerDaemonContext): { dispose?: () => void } {
  const { bus } = context;

  // ── Inspect the machine — something only code beside the files can do ──────
  // Read the hostname, the cwd, and a short listing of that directory. In
  // production the daemon's cwd is the machine's working area, so this proves
  // the code is genuinely running on the remote machine, not the host.
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

  // ── Direction 1: ANSWER a caller's request ──────────────────────────────────
  // A surface (or host daemon) calls `bus.extension.request('worker.inspect',
  // {}, { target: { machine } })`; the responder registered here returns the
  // answer and the PLATFORM carries it back to the awaiting promise — the
  // correlation and the timeout are the bus's job, so neither side mints
  // request ids or matches replies by hand. The target selects the realm: a
  // request WITH a target lands on this machine's responder, one WITHOUT stays
  // among the surface/host responders. The envelope carries the routing facts:
  // a slot-scoped call would arrive with `envelope.reservationId` set, which
  // is how one daemon serves every slot on its machine without the payload
  // naming them. A respond() for a type is a per-type upsert across the
  // extension's daemons on this machine.
  bus.extension.respond('worker.inspect', (_payload, _envelope) => inspect());

  // ── Direction 2: PUSH unsolicited heartbeats to every subscriber ────────────
  // Nothing asked for these. The daemon decides on its own to report it's
  // alive; every surface/host subscriber of 'worker.heartbeat' receives the
  // publish with an envelope naming this machine — no relay, no re-publish.
  // Fire-and-forget traffic like this stays on publish()/subscribe(); a
  // publish while the daemon link is down is dropped with a log, so a brief
  // disconnect is harmless.
  function beat(): void {
    const msg: WorkerHeartbeat = {
      hostname: os.hostname(),
      at: new Date().toISOString(),
    };
    bus.extension.publish('worker.heartbeat', msg);
  }

  beat(); // one immediately on connect, so a UI sees life right away
  const timer = setInterval(beat, HEARTBEAT_MS);

  // The host can't see our interval — clean it up ourselves on unload. This is
  // the daemon's `dispose`, returned from mount: the single unload hook, the same
  // shape all three realms use.
  return { dispose: () => clearInterval(timer) };
}
