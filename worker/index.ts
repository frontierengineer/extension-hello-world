// ═══════════════════════════════════════════════════════════════════════════
//  worker/index.ts — NEXT TO THE FILES
// ═══════════════════════════════════════════════════════════════════════════
//
//  REALM: worker (the daemon-side bundle). The host bundles this to a node
//  CJS module and EVERY connected worker daemon fetches + require()s + registers
//  it on connect — so this code runs ON THE MACHINE, next to its files, not in
//  the host. Like the surface and host realms, register() is declaration-only: it
//  names one daemon whose mount() receives the flat WorkerDaemonHost and returns
//  the teardown. It registers no runtime or workspace provider; it exists purely
//  so extension logic can do things that only make sense beside the machine (read
//  the local filesystem, the hostname, the working directory) and stream the
//  results to its own host-bundle code.
//
//  KEY RULE — a worker reaches the UI by going THROUGH its host bundle. A worker
//  component has NO bus and NO window; the only thing it can talk to is its own
//  host/ code, over `channel`. To make something appear in the UI it sends to
//  the host bundle, and the host bundle re-publishes it on the bus to the UIs (see
//  host/index.ts §8). This file shows both halves of that:
//    • it ANSWERS the host bundle's inspect request (request/response, correlated), and
//    • it PUSHES an unsolicited heartbeat the host bundle fans out to every UI.
//
//  Node built-ins (fs/os/path) are imported normally — esbuild keeps them
//  external in the node CJS bundle. `../../types` is type-only and erased.

import * as fs from 'fs';
import * as os from 'os';
import type { WorkerProvider, WorkerDaemonHost } from '../../types';
import type { WorkerMsg, WorkerInspectReply } from '../messages';

const HEARTBEAT_MS = 30_000; // push a heartbeat to the host twice a minute
const MAX_ENTRIES = 20;      // cap the directory listing we send back

export function register(provider: WorkerProvider): void {
  const w = provider.version(1);
  // register() is declaration-only: it names the one daemon this worker bundle
  // runs. Everything below lives inside that daemon's mount().
  w.daemon.register({ mount });
}

// The hello-world worker daemon. Its mount() receives the flat WorkerDaemonHost:
// `channel` is this component's end of the link to its host bundle code, and the
// rest (importWorker for worker-located module resolution, hostUrl) sits flat
// beside it (unused here — this component needs only node built-ins). mount
// returns the component's teardown as `dispose`.
function mount(host: WorkerDaemonHost): { dispose?: () => void } {
  const { channel } = host;

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

  // ── Direction 1: ANSWER the host bundle's request (correlated by cid) ───────────
  // The host bundle sends `{ kind: 'inspect.req', cid }`; we reply with the SAME cid
  // on `{ kind: 'inspect.res', cid, reply }` so the host bundle can match the answer
  // to the question it asked. We don't invent the correlation — we just echo
  // back the cid the host bundle chose. Unknown message kinds are ignored.
  channel.onMessage((raw: any) => {
    const msg = raw as WorkerMsg;
    if (msg.kind === 'inspect.req') {
      const res: WorkerMsg = { kind: 'inspect.res', cid: msg.cid, reply: inspect() };
      channel.send(res); // → this extension's host-bundle code on the host
    }
  });

  // ── Direction 2: PUSH unsolicited heartbeats the host bundle fans out to UIs ────
  // Nothing asked for these. The component decides on its own to report it's
  // alive; the host bundle re-publishes each on the bus so every connected UI sees
  // it (the worker→host→bus→all-UIs path). `channel.send` while the daemon
  // link is down is dropped with a log, so a brief disconnect is harmless.
  function beat(): void {
    const msg: WorkerMsg = {
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
