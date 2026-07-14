// ═══════════════════════════════════════════════════════════════════════════
//  host/index.ts — THE HUB
// ═══════════════════════════════════════════════════════════════════════════
//
//  REALM: host (the host-process bundle). Runs once, in the HOST process, when
//  the extension loads. It is the only bundle that can talk to BOTH the UI
//  (over the bus) and the worker component (over the worker channel) — so it
//  sits in the middle and everything routes through it:
//
//        surface/index.tsx  ──bus.extension──►  host/index.ts  ──workers.channel──►  worker/index.ts
//        (the browser)  ◄────────────────     (THIS FILE)     ◄──────────────────   (the daemon)
//
//  An extension is up to three bundles, one directory each — surface/ (browser),
//  host/ (this), worker/ (each machine's daemon) — compiled, loaded, and run
//  separately in their own realms. MCP tools and voice overrides live on the
//  host realm, so this one file both answers the UI and contributes the agent
//  tool (§7); there is no separate mcp/ bundle.
//
//  This file demonstrates, each in its own captioned section:
//    §1  Store          — read/write the extension's durable state
//    §2  Self-migration — upgrade our OWN Store data across schema versions
//    §3  Settings       — a setting the extension owns the UI for (Store-backed)
//    §4  Scheduler      — a recurring host-managed timer
//    §5  Private bus    — request/respond + publish for THIS extension's UI
//    §6  Public bus     — one versioned endpoint OTHER extensions can call
//    §7  MCP            — a tool the agent can call (host realm, shared memory)
//    §8  Worker channel — request/response correlation to the worker component,
//                         plus fanning the worker's pushes out to every UI
//
//  The contract type comes from the host. `../../types` resolves to the vendored
//  contract at the repo root here, and to the host-written shim in production —
//  see README → "How types resolve".
//
//  register() receives a PROVIDER; call version(1) for the v1 realm shape.
//  Everything registered is auto-tracked and torn down on reload — we only add
//  a deregister() for state the host can't see (here: the worker heartbeat fan).

// Two different import depths, and the difference matters:
//   • `../../types`   — the HOST contract. Two levels up because in production
//     the host writes a types shim ABOVE the extension dir (extensions/types.ts),
//     a sibling of every installed extension. (Standalone: the vendored copy at
//     this repo's root, reached the same way — see README.)
//   • `../messages`   — THIS extension's OWN shared file at its root, one level
//     up from a realm dir. It is not a host file; it ships with us.
import type {
  HostProvider,
  Store,
  Scheduler,
  WorkerChannel,
  ToolResult,
  ToolContext,
} from '../../types';
import type { HelloState, WorkerMsg, WorkerInspectReply } from '../messages';

// ── Store key + defaults ───────────────────────────────────────────────────
// One key holds the whole state blob as JSON, read and written through the
// Store's typed getJson/putJson pair (it parses/serializes for us). The
// `state/` prefix is just a namespace inside our own private data dir.
const STATE_KEY = 'state/hello';

function freshState(): HelloState {
  return { count: 0, note: '', updatedAt: new Date().toISOString() };
}

// ═══════════════════════════════════════════════════════════════════════════
//  §2  SELF-MANAGED MIGRATION — upgrade our OWN Store data ourselves
// ═══════════════════════════════════════════════════════════════════════════
//  WHY this lives here now: the host NEVER understands an extension's Store —
//  it's raw bytes WE own. There is no `dataVersion` manifest field and no
//  host-called `migrate()` hook anymore; an extension self-manages format
//  changes inside its OWN stored data. That means WE keep the version marker
//  (another key in our own Store), WE decide when it runs, and WE step it
//  forward.
//
//  THE PATTERN:
//    • SCHEMA_VERSION is the format THIS build writes.
//    • VERSION_KEY holds the version our data was last migrated to — OUR key in
//      OUR Store (contrast the old model, where the host owned that marker).
//    • On load, before we serve any request, we read the marker and, if it is
//      behind, step one version at a time (v1→v2, then v2→v3, …) so any starting
//      point converges, then stamp the new version. A brand-new install has no
//      state to migrate: the marker is absent (read as 0) and we simply stamp
//      the current version. Persisting the blob before the marker means a crash
//      mid-migration just re-runs the idempotent step on the next load — never
//      half-migrated.
//
//  This example's step is deliberately trivial: backfill the `note` field v2
//  added onto a v1 record.
const SCHEMA_VERSION = 2;               // the on-disk format this build writes
const VERSION_KEY = 'state/version';    // OUR migration marker, in OUR own Store

async function migrateStore(store: Store): Promise<void> {
  const marker = await store.getJson<number>(VERSION_KEY);
  const from = marker.ok && typeof marker.value === 'number' ? marker.value : 0;
  if (from >= SCHEMA_VERSION) return;
  if (from < 2) {
    const r = await store.getJson<Partial<HelloState>>(STATE_KEY);
    if (!r.ok) throw new Error(r.error.message);
    if (r.value !== null) {
      const old = r.value;
      // v2 added `note`; backfill it on records written by v1.
      const upgraded: HelloState = {
        count: typeof old.count === 'number' ? old.count : 0,
        note: typeof old.note === 'string' ? old.note : '',
        updatedAt: new Date().toISOString(),
      };
      await store.putJson({ key: STATE_KEY, value: upgraded });
    }
  }
  await store.putJson({ key: VERSION_KEY, value: SCHEMA_VERSION });
  console.log(`[hello-world] migrated Store ${from} → ${SCHEMA_VERSION}`);
}

export function register(hostProvider: HostProvider): void {
  const h = hostProvider.version(1);
  // `bus` is this extension's bus; `workers` reaches its worker component;
  // `services` are the backing capabilities (store, scheduler, …). `mcp`
  // registers tools the agent can call (§7).
  const { bus, workers, services } = h;
  const store: Store = services.store;
  const scheduler: Scheduler = services.scheduler;

  // ─────────────────────────────────────────────────────────────────────────
  //  §1  STORE — durable, per-extension key/value state
  // ─────────────────────────────────────────────────────────────────────────
  //  REALM: host owns persistence. The Store is private to this extension
  //  (its own dir on disk) and survives restarts AND extension updates. The UI
  //  never touches it directly — it asks the host bundle (see §5), so there is one
  //  writer and one source of truth.

  // Read the state blob, tolerating an absent/corrupt key by falling back to a
  // fresh default (a brand-new install has no key yet).
  async function readState(): Promise<HelloState> {
    const r = await store.getJson<HelloState>(STATE_KEY);
    if (!r.ok || r.value === null) return freshState();
    return r.value;
  }

  // Persist the state blob AND announce the change on the bus (§5) so every
  // open UI re-renders. One helper = every mutation stays consistent.
  async function writeState(next: HelloState): Promise<HelloState> {
    next.updatedAt = new Date().toISOString();
    await store.putJson({ key: STATE_KEY, value: next });
    bus.extension.publish('state.changed', next);
    return next;
  }

  // We own our data migration (§2): run it FIRST, so by the time any responder
  // below serves a request the Store is guaranteed to be at the current format
  // and register() never has to defend against an old shape. Then make the state
  // blob exist so the very first UI read gets a real value. A typed Store read
  // returns a wrapper, so a miss is `{ value: null }` — read `.value`, never
  // compare the result object to null. Responders below await `ready` so none
  // races this startup.
  const ready = (async () => {
    await migrateStore(store);
    if ((await store.getString(STATE_KEY)).value === null) await writeState(freshState());
    await loadGreeting();
  })();

  // ─────────────────────────────────────────────────────────────────────────
  //  §3  SETTINGS — a setting the extension OWNS the UI for (in-app)
  // ─────────────────────────────────────────────────────────────────────────
  //  REALM: host. There is no config service and no host-rendered settings
  //  panel: a setting is just durable Store state under a `settings/` prefix,
  //  which the extension reads here and writes from its OWN in-app editing
  //  surface (surface/index.tsx), exposing get/set to its UI over the bus (§5).
  //  We cache the value in memory so this accessor stays synchronous, seed it
  //  from the Store as part of `ready` (loadGreeting), and refresh the cache on
  //  every write. This is the canonical "settings live in your own UI, persisted
  //  to the Store" pattern.
  const DEFAULT_GREETING = 'Hello';
  const GREETING_KEY = 'settings/greeting';
  let currentGreeting = DEFAULT_GREETING;
  // A tiny accessor so other sections read the current value in one place.
  const greeting = (): string => currentGreeting;
  // Seed / refresh the cached greeting from the Store (settings/greeting).
  async function loadGreeting(): Promise<void> {
    const r = await store.getJson<string>(GREETING_KEY);
    currentGreeting = r.ok && typeof r.value === 'string' && r.value ? r.value : DEFAULT_GREETING;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  §4  SCHEDULER — a recurring, host-managed timer
  // ─────────────────────────────────────────────────────────────────────────
  //  REALM: host. Instead of running its own setInterval, the extension hands
  //  the host a callback + a schedule; the host owns the timer and disposes it
  //  on reload. This one is a PURE timer (it dispatches no agent turn), so it
  //  takes no reservationId — it must not hold a workspace slot. Here it just
  //  re-announces the current state every few minutes to keep idle UIs fresh.
  scheduler.register({
    id: 'hello-world.heartbeat',
    // A ScheduleSpecification names both axes and nulls the unused one — the
    // fields are required-and-nullable, so 'interval' sets `interval` and leaves
    // `cron: null` rather than omitting it.
    schedule: { kind: 'interval', interval: 5 * 60_000, cron: null }, // every 5 minutes
    handler: async () => {
      await ready;
      const state = await readState();
      bus.extension.publish('state.changed', state);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  §5  PRIVATE BUS — request/respond + publish for THIS extension's UI
  // ─────────────────────────────────────────────────────────────────────────
  //  REALM: host answers its own UI. `bus.extension` is fully PRIVATE — no
  //  other extension can see it. A `request` from surface/index.tsx lands on the
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

  // The greeting SETTING, read + written over the bus (its in-app surface lives
  // in surface/index.tsx). The UI never touches the Store directly — it asks the
  // host bundle, so there is one writer and one source of truth (the same rule as the
  // Store state in §1). `set` persists to settings/greeting and announces the
  // change so an open UI updates live.
  bus.extension.respond('greeting.get', async () => { await ready; return { greeting: greeting() }; });

  bus.extension.respond('greeting.set', async (params: { greeting: string }) => {
    const value = (typeof params?.greeting === 'string' ? params.greeting : '').trim() || DEFAULT_GREETING;
    await store.putJson({ key: GREETING_KEY, value }); // async: resolves once the write hits disk
    currentGreeting = value;
    bus.extension.publish('greeting.changed', { greeting: value });
    console.log(`[hello-world] greeting is now: ${value}`);
    return { greeting: value };
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  §6  PUBLIC BUS — one versioned endpoint OTHER extensions can call
  // ─────────────────────────────────────────────────────────────────────────
  //  REALM: host, cross-extension contract. `bus.public.respond(topic,
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
  //  §7  MCP — a tool the AGENT can call (same realm as the rest of host/)
  // ─────────────────────────────────────────────────────────────────────────
  //  REALM: host. `h.mcp.registerTool` contributes a tool to EVERY agent turn
  //  across all sessions; the host namespaces it by extension id, so the agent
  //  sees this one as `hello-world.bump`. MCP is not its own bundle — it lives
  //  in host/, the same realm (and the same module instance) as the bus
  //  responders above, so this tool shares memory with them: it reuses the very
  //  same readState/writeState, and because writeState publishes on the private
  //  bus, bumping the counter from the agent updates every open UI instantly —
  //  no Store-polling seam needed. The handler runs on the HOST (not the
  //  worker), so it has the extension's Store, scheduler, and bus. `description`
  //  is what the model reads to decide when to call it — write it for the agent;
  //  `inputSchema` is JSON Schema the host converts for the MCP SDK;
  //  `ctx.sessionId` identifies the agent run (unused here).
  // A ToolResult sets `isError` explicitly (null-over-optional): null marks a
  // normal result; return `isError: true` for a failure the agent should reason
  // about.
  const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: null });
  h.mcp.registerTool({
    name: 'bump',
    title: 'Bump the Hello World counter',
    description:
      'Increment the Hello World extension\'s shared counter. Use when asked to ' +
      'demonstrate that an agent can mutate an extension\'s persisted state via a tool. ' +
      'Pass `by` to add more than 1.',
    inputSchema: {
      type: 'object',
      properties: {
        by: { type: 'number', description: 'How much to add (default 1).' },
      },
    },
    handler: async (args: { by?: number }, _ctx: ToolContext): Promise<ToolResult> => {
      await ready;
      const state = await readState();
      state.count += typeof args?.by === 'number' ? args.by : 1;
      // writeState persists AND publishes state.changed, so every open UI
      // re-renders the moment the agent bumps the counter.
      await writeState(state);
      return text(`Counter is now ${state.count}.`);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  §8  WORKER CHANNEL — the headline: talk to the daemon-side component
  // ─────────────────────────────────────────────────────────────────────────
  //  REALM: host ⇄ worker. `workers.channel(machine)` is a raw, machine-scoped
  //  link to THIS extension's worker component on a connected machine. The
  //  platform guarantees only ordered delivery of opaque JSON — NO request/
  //  response correlation. So we build our own: tag each request with a
  //  correlation id (`cid`), park a promise keyed by that cid, and resolve it
  //  when a reply carrying the same cid arrives. (This is the tiny correlation
  //  helper the brief asks for — the platform channel is send/onMessage only.)
  //
  //  We also wire the OTHER direction: the worker PUSHES an unsolicited
  //  `heartbeat`, and we re-publish it on the bus so EVERY UI sees it. That is
  //  the worker→host→bus→all-UIs fan-out — a worker has no path to the UI of
  //  its own; it reaches the user by going through its host bundle. THIS is that.

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
  // the UI asks the host bundle, which asks the worker, the answer flows back.
  bus.extension.respond('worker.inspect', async (params: { machine: string }) => {
    const machine = typeof params?.machine === 'string' ? params.machine : '';
    if (!machine) throw new Error('worker.inspect: machine required');
    return inspectWorker(machine);
  });

  void ready.then(() => console.log(`[hello-world] host ready (${greeting()})`));

  // Tear down the one thing the host can't track for us: settle any in-flight
  // worker requests so their promises don't dangle past a reload. (Bus
  // responders and the schedule are auto-cleaned.)
  h.deregister({ teardown: () => {
    for (const [cid, resolve] of Array.from(pending.entries())) {
      pending.delete(cid);
      // Resolve with an empty listing rather than leak a hanging promise.
      resolve({ hostname: '', platform: '', cwd: '', entries: [] });
    }
    channels.clear();
  } });
}
