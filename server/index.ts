// ═══════════════════════════════════════════════════════════════════════════
//  server/index.ts — THE HUB
// ═══════════════════════════════════════════════════════════════════════════
//
//  TIER: server (the host-side coordinator). Runs once, in the HOST process,
//  when the extension loads. It is the only half that can talk to BOTH the UI
//  (over the bus) and the worker component (over the worker channel) — so it
//  sits in the middle and everything routes through it:
//
//        ui/index.tsx  ──bus.extension──►  server/index.ts  ──workers.channel──►  worker/index.ts
//        (the browser)  ◄────────────────     (THIS FILE)      ◄──────────────────   (the daemon)
//
//  This file demonstrates, each in its own captioned section:
//    §1  Store          — read/write the extension's durable state
//    §2  migrate()      — the data-migration pattern across schema versions
//    §3  Config         — declare a setting + react to edits (config.watch)
//    §4  Scheduler      — a recurring host-managed timer
//    §5  Private bus    — request/respond + publish for THIS extension's UI
//    §6  Public bus     — one versioned endpoint OTHER extensions can call
//    §7  Worker channel — request/response correlation to the worker component,
//                         plus fanning the worker's pushes out to every UI
//
//  The contract type comes from the host. `../../types` resolves to the vendored
//  contract at the repo root here, and to the host-written shim in production —
//  see README → "How types resolve".
//
//  register() receives a PROVIDER; call version(1) for the v1 capability shape.
//  Everything registered is auto-tracked and torn down on reload — we only add
//  a deregister() for state the host can't see (here: the worker heartbeat fan).

// Two different import depths, and the difference matters:
//   • `../../types`   — the HOST contract. Two levels up because in production
//     the host writes a types shim ABOVE the extension dir (extensions/types.ts),
//     a sibling of every installed extension. (Standalone: the vendored copy at
//     this repo's root, reached the same way — see README.)
//   • `../messages`   — THIS extension's OWN shared file at its root, one level
//     up from a capability dir. It is not a host file; it ships with us.
import type {
  ServerProvider,
  Store,
  Config,
  Scheduler,
  WorkerChannel,
} from '../../types';
import type { HelloState, WorkerMsg, WorkerInspectReply } from '../messages';

// ── Store key + defaults ───────────────────────────────────────────────────
// One key holds the whole state blob as JSON. The Store is raw strings, so WE
// own the serialization (JSON.stringify on write, JSON.parse on read). The
// `state/` prefix is just a namespace inside our own private data dir.
const STATE_KEY = 'state/hello';

function freshState(): HelloState {
  return { count: 0, note: '', updatedAt: new Date().toISOString() };
}

// ═══════════════════════════════════════════════════════════════════════════
//  §2  migrate() — THE DATA-MIGRATION PATTERN (a host-called export)
// ═══════════════════════════════════════════════════════════════════════════
//  WHY this exists: the host NEVER understands an extension's Store — it's raw
//  bytes WE own. So when our on-disk FORMAT changes across a release (renamed a
//  field, split a blob, added a structure), WE migrate our OWN data. The host
//  just gives us the hook and stamps the version so it runs exactly once.
//
//  THE CONTRACT (docs/ideas/migrations.md — this is the reference):
//    • extension.json declares `dataVersion: N` — the format THIS package ships.
//    • The host keeps its OWN marker of the version our data was last migrated
//      to (a file beside our data dir — we never see it, never write it).
//    • On load, BEFORE register() runs, if the marker is behind dataVersion the
//      host calls this `migrate(from, to, store)` once, then stamps `to`. A
//      brand-new install with no prior data is stamped straight to N with NO
//      migrate call (nothing to migrate). A throw leaves the marker behind and
//      the extension unloaded, so the next reload retries — never half-migrated.
//
//  So this is a plain module-level export (not called from register): the host
//  owns when and whether it runs. Step one version at a time (v1→v2, then v2→v3,
//  …) so any starting point converges. This example's step is deliberately
//  trivial — backfill the field v2 added onto a v1 record.
export async function migrate(fromVersion: number, toVersion: number, store: Store): Promise<void> {
  if (fromVersion < 2) {
    const raw = await store.get(STATE_KEY);
    if (raw !== null) {
      const old = JSON.parse(raw) as Partial<HelloState>;
      // v2 added `note`; backfill it on records written by v1.
      const upgraded: HelloState = {
        count: typeof old.count === 'number' ? old.count : 0,
        note: typeof old.note === 'string' ? old.note : '',
        updatedAt: new Date().toISOString(),
      };
      await store.put(STATE_KEY, JSON.stringify(upgraded));
    }
  }
  console.log(`[hello-world] migrated Store ${fromVersion} → ${toVersion}`);
}

export function register(serverProvider: ServerProvider): void {
  const server = serverProvider.version(1);
  // `bus` is this extension's bus; `workers` reaches its worker component;
  // `services` are the backing capabilities (store, config, scheduler, …).
  const { bus, workers, services } = server;
  const store: Store = services.store;
  const config: Config = services.config;
  const scheduler: Scheduler = services.scheduler;

  // ─────────────────────────────────────────────────────────────────────────
  //  §1  STORE — durable, per-extension key/value state
  // ─────────────────────────────────────────────────────────────────────────
  //  TIER: server owns persistence. The Store is private to this extension
  //  (its own dir on disk) and survives restarts AND extension updates. The UI
  //  never touches it directly — it asks the server (see §5), so there is one
  //  writer and one source of truth.

  // Read the state blob, tolerating an absent/corrupt key by falling back to a
  // fresh default (a brand-new install has no key yet).
  async function readState(): Promise<HelloState> {
    const raw = await store.get(STATE_KEY);
    if (raw === null) return freshState();
    try {
      return JSON.parse(raw) as HelloState;
    } catch {
      return freshState();
    }
  }

  // Persist the state blob AND announce the change on the bus (§5) so every
  // open UI re-renders. One helper = every mutation stays consistent.
  async function writeState(next: HelloState): Promise<HelloState> {
    next.updatedAt = new Date().toISOString();
    await store.put(STATE_KEY, JSON.stringify(next));
    bus.extension.publish('state.changed', next);
    return next;
  }

  // The data migration is the module-level `migrate()` export above (§2) — the
  // host runs it BEFORE this register() when our data is behind dataVersion, so
  // by here the Store is guaranteed to be at the current format. register()
  // never has to defend against an old shape. All we do on load is make the
  // state blob exist so the very first UI read gets a real value; responders
  // below await `ready` so none races that first write.
  const ready = (async () => {
    if ((await store.get(STATE_KEY)) === null) await writeState(freshState());
  })();

  // ─────────────────────────────────────────────────────────────────────────
  //  §3  CONFIG — a user-editable setting + reacting to edits
  // ─────────────────────────────────────────────────────────────────────────
  //  TIER: server declares; the HOST renders the input in Settings; the USER
  //  sets it; the extension only READS. Declaring a field is all it takes for
  //  it to appear in the host's auto-generated settings UI. `config.watch`
  //  fires when the user saves — the extension reacts live (no reload).
  config.declare({
    key: 'greeting',
    label: 'Greeting',
    description: 'Text the welcome tile and the worker heartbeat log greet you with.',
    type: 'string',
    default: 'Hello',
  });

  // A tiny accessor so other sections read the current value in one place.
  const greeting = (): string => config.get<string>('greeting') ?? 'Hello';

  // React to the user editing the setting. Auto-cleaned on deregister.
  config.watch('greeting', (value) => {
    console.log(`[hello-world] greeting is now: ${value}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  §4  SCHEDULER — a recurring, host-managed timer
  // ─────────────────────────────────────────────────────────────────────────
  //  TIER: server. Instead of running its own setInterval, the extension hands
  //  the host a callback + a schedule; the host owns the timer and disposes it
  //  on reload. This one is a PURE timer (it dispatches no agent turn), so it
  //  takes no reservationId — it must not hold a workspace slot. Here it just
  //  re-announces the current state every few minutes to keep idle UIs fresh.
  scheduler.register({
    id: 'hello-world.heartbeat',
    schedule: { kind: 'interval', interval: 5 * 60_000 }, // every 5 minutes
    handler: async () => {
      await ready;
      const state = await readState();
      bus.extension.publish('state.changed', state);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  §5  PRIVATE BUS — request/respond + publish for THIS extension's UI
  // ─────────────────────────────────────────────────────────────────────────
  //  TIER: server answers its own UI. `bus.extension` is fully PRIVATE — no
  //  other extension can see it. A `request` from ui/index.tsx lands on the
  //  matching `respond` here; the return value travels back to the UI promise.
  //  `publish` (used in writeState above) fans an event out to every UI that
  //  subscribed. This is the extension's frontend↔backend microservice link.
  //
  //  Each responder's payload/return type is checked against messages.ts, so a
  //  UI call and this handler can't drift apart silently.

  bus.extension.respond('state.get', async () => {
    await ready;
    return readState();
  });

  bus.extension.respond('state.bump', async (params: { by?: number }) => {
    await ready;
    const state = await readState();
    state.count += typeof params?.by === 'number' ? params.by : 1;
    return writeState(state);
  });

  bus.extension.respond('note.set', async (params: { note: string }) => {
    await ready;
    const state = await readState();
    state.note = typeof params?.note === 'string' ? params.note : '';
    return writeState(state);
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  §6  PUBLIC BUS — one versioned endpoint OTHER extensions can call
  // ─────────────────────────────────────────────────────────────────────────
  //  TIER: server, cross-extension contract. `bus.public.respond(topic,
  //  version, handler)` exposes ONE endpoint outside this extension. Another
  //  extension reaches it read-only via `bus.extensions('hello-world')
  //  .request('count.get')`, and a running agent can reach it via the host
  //  `frontier.bus_call` tool. The PRIVATE responders in §5 stay invisible —
  //  only what is registered here crosses the boundary. Versioning is
  //  first-class: ship a v2 alongside v1, then bus.public.deprecate(...) the
  //  old one when callers have moved.
  bus.public.respond('count.get', 1, async () => {
    await ready;
    const state = await readState();
    return { count: state.count };
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  §7  WORKER CHANNEL — the headline: talk to the daemon-side component
  // ─────────────────────────────────────────────────────────────────────────
  //  TIER: server ⇄ worker. `workers.channel(machine)` is a raw, machine-scoped
  //  link to THIS extension's worker component on a connected machine. The
  //  platform guarantees only ordered delivery of opaque JSON — NO request/
  //  response correlation. So we build our own: tag each request with a
  //  correlation id (`cid`), park a promise keyed by that cid, and resolve it
  //  when a reply carrying the same cid arrives. (This is the tiny correlation
  //  helper the brief asks for — the platform channel is send/onMessage only.)
  //
  //  We also wire the OTHER direction: the worker PUSHES an unsolicited
  //  `heartbeat`, and we re-publish it on the bus so EVERY UI sees it. That is
  //  the worker→server→bus→all-UIs fan-out — a worker has no path to the UI of
  //  its own; it reaches the user by going through its server. THIS is that.

  // One channel per machine, created on first use, each with its onMessage
  // wired exactly once. A channel is a cheap handle over live connection state.
  const channels = new Map<string, WorkerChannel>();
  // cid → resolver for an in-flight inspect request awaiting its reply.
  const pending = new Map<string, (reply: WorkerInspectReply) => void>();

  function channelFor(machine: string): WorkerChannel {
    let ch = channels.get(machine);
    if (ch) return ch;
    ch = workers.channel(machine);
    ch.onMessage((raw: any) => {
      const msg = raw as WorkerMsg;
      if (msg.kind === 'inspect.res') {
        // Match the reply to the request that's awaiting it, then settle it.
        const resolve = pending.get(msg.cid);
        if (resolve) {
          pending.delete(msg.cid);
          resolve(msg.reply);
        }
      } else if (msg.kind === 'heartbeat') {
        // FAN-OUT: a push from the daemon, re-published to every connected UI.
        bus.extension.publish('worker.heartbeat', {
          machine,
          hostname: msg.hostname,
          at: msg.at,
        });
      }
    });
    channels.set(machine, ch);
    return ch;
  }

  // The correlation helper: send an inspect request and await the matching
  // reply (or time out so a dropped machine never hangs the UI forever).
  function inspectWorker(machine: string, timeoutMs = 5_000): Promise<WorkerInspectReply> {
    const ch = channelFor(machine);
    const cid = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<WorkerInspectReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(cid);
        reject(new Error(`worker ${machine} did not reply within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(cid, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      const req: WorkerMsg = { kind: 'inspect.req', cid };
      try {
        ch.send(req); // throws synchronously if the machine is disconnected
      } catch (err: any) {
        clearTimeout(timer);
        pending.delete(cid);
        reject(err);
      }
    });
  }

  // Expose the round-trip to the UI as a normal private request (§5 surface):
  // the UI asks the server, the server asks the worker, the answer flows back.
  bus.extension.respond('worker.inspect', async (params: { machine: string }) => {
    const machine = typeof params?.machine === 'string' ? params.machine : '';
    if (!machine) throw new Error('worker.inspect: machine required');
    return inspectWorker(machine);
  });

  console.log(`[hello-world] server ready (${greeting()})`);

  // Tear down the one thing the host can't track for us: settle any in-flight
  // worker requests so their promises don't dangle past a reload. (Bus
  // responders, the config.watch, and the schedule are auto-cleaned.)
  server.deregister(() => {
    for (const [cid, resolve] of Array.from(pending.entries())) {
      pending.delete(cid);
      // Resolve with an empty listing rather than leak a hanging promise.
      resolve({ hostname: '', platform: '', cwd: '', entries: [] });
    }
    channels.clear();
  });
}
