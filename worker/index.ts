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
//  (w.runtime.register), WORKSPACE providers (w.workspace.register), and the
//  general-purpose DAEMON (w.daemon.register). Hello World contributes only a
//  daemon; each component's mount() receives its own flat context
//  (WorkerDaemonContext here) and its logic lives inside.
//
//  KEY RULE — a worker reaches the UI by going THROUGH its host bundle. A worker
//  component has NO bus and NO window; the only thing it can talk to is its own
//  host/ code, over `channel`. To make something appear in the UI it sends to
//  the host bundle, and the host bundle re-publishes it on the bus to the UIs (see
//  host/index.ts §8). This file shows both halves of that:
//    • it ANSWERS the host bundle's inspect request (channel.onRequest — the
//      platform owns the correlation and the timeout), and
//    • it PUSHES an unsolicited heartbeat the host bundle fans out to every UI
//      (channel.send — fire-and-forget, the streaming half of the link).
//
//  Node built-ins (fs/os/path) are imported normally — esbuild keeps them
//  external in the node CJS bundle. (context.modules is the daemon-located
//  loader for modules that are NOT bundled — machine-installed packages like
//  node-pty or an agent SDK; unused here, node built-ins are all we need.)
//  `../../types` is type-only and erased.

import * as fs from 'fs';
import * as os from 'os';
import type { WorkerProvider, WorkerDaemonContext } from '../../types';
import type { WorkerPush, WorkerRequest, WorkerInspectReply } from '../messages';

const HEARTBEAT_MS = 30_000; // push a heartbeat to the host twice a minute
const MAX_ENTRIES = 20;      // cap the directory listing we send back

export function register(provider: WorkerProvider): void {
  const w = provider.version(1);
  // register() is declaration-only: it names the one component this worker
  // bundle contributes (a daemon; a runtime or a workspace provider would be
  // registered here at the top level the same way). Everything below lives
  // inside the daemon's mount().
  w.daemon.register({ mount });
}

// The hello-world worker daemon. Its mount() receives the flat
// WorkerDaemonContext: `channel` is this component's end of the link to its host
// bundle code, and the rest (actions, execute, modules, hostUrl) sits flat
// beside it (unused here — this component needs only node built-ins). mount
// returns the component's teardown as `dispose`.
function mount(context: WorkerDaemonContext): { dispose?: () => void } {
  const { channel } = context;

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

  // ── Direction 1: ANSWER the host bundle's request ───────────────────────────
  // The host bundle calls `channel(machine).request({ kind: 'inspect' })`; the
  // handler registered here returns the answer and the PLATFORM carries it back
  // to the awaiting promise — the correlation and the timeout are the channel's
  // job now, so neither side mints request ids or matches replies by hand.
  // One responder serves the extension on this machine (re-registering
  // replaces it); branch on the payload's `kind` to grow the protocol.
  channel.onRequest((raw: unknown) => {
    const msg = raw as WorkerRequest;
    if (msg.kind === 'inspect') return inspect();
    throw new Error(`hello-world worker: unknown request kind ${(msg as { kind?: string }).kind}`);
  });

  // ── Direction 2: PUSH unsolicited heartbeats the host bundle fans out to UIs ────
  // Nothing asked for these. The component decides on its own to report it's
  // alive; the host bundle re-publishes each on the bus so every connected UI sees
  // it (the worker→host→bus→all-UIs path). Fire-and-forget traffic like this
  // stays on send()/onMessage(); `channel.send` while the daemon link is down is
  // dropped with a log, so a brief disconnect is harmless.
  function beat(): void {
    const msg: WorkerPush = {
      kind: 'heartbeat',
      hostname: os.hostname(),
      at: new Date().toISOString(),
    };
    channel.send(msg);
  }

  beat(); // one immediately on connect, so a UI sees life right away
  const timer = setInterval(beat, HEARTBEAT_MS);

  // The host can't see our interval — clean it up ourselves on unload. This is
  // the daemon's `dispose`, returned from mount: the single unload hook, the same
  // shape all three realms use.
  return { dispose: () => clearInterval(timer) };
}
