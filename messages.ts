// ─────────────────────────────────────────────────────────────────────────
// messages.ts — the shared, typed message contract for this extension.
//
// The connection is untyped JSON on the wire; this file is the COMPILE-TIME
// contract the bundles agree on. `host/index.ts`, `surface/index.tsx`, and
// `worker/index.ts` all import these types so a request and its responder, or
// an event and its subscriber, can't drift out of shape without a type error.
//
// THE TOPOLOGY THIS CONTRACT IS SHAPED BY. Every bundle holds exactly ONE
// connection and it is always to the HOST bundle: a surface never addresses a
// worker, and a worker never addresses a surface. So a message that crosses
// from a surface to a worker is TWO messages — one on each leg — and this file
// names them separately:
//
//   • `SurfaceRequests` / `SurfaceEvents` — the surface ⇄ host-bundle leg.
//     Topics here are named for what the SURFACE is asking about, so anything
//     concerning a worker is prefixed `worker.`.
//   • `WorkerRequests` / `WorkerEvents` — the host-bundle ⇄ worker leg. Bare
//     topic names, because inside that leg there is only one peer to mean.
//
// The two legs deliberately do NOT share topic names. A topic answers in
// exactly one bundle, and naming the legs apart is what makes it obvious which
// one: `worker.inspect` is answered by the host daemon (which forwards), and
// `inspect` is answered by the worker daemon.
// ─────────────────────────────────────────────────────────────────────────

// The single piece of durable state this extension keeps: a counter the user
// bumps from the UI or an agent bumps via the MCP tool, plus a free-text note.
export interface HelloState {
  count: number;
  note: string;
  // ISO timestamp of the last mutation — proves the Store round-trips.
  updatedAt: string;
}

// ── The surface ⇄ host-bundle leg: requests ────────────────────────────────
//
// Each key is a request topic; `params` is what the surface sends, `response`
// is what the host daemon's responder returns. This is the extension's PRIVATE
// request surface — only this extension's own bundles can call it.
export interface SurfaceRequests {
  // Read the current persisted state (the counter + note).
  'state.get': { params: Record<string, never>; response: HelloState };
  // Bump the counter by `by` (default 1) and persist; returns the new state.
  'state.bump': { params: { by?: number }; response: HelloState };
  // Replace the note text and persist; returns the new state.
  'note.set': { params: { note: string }; response: HelloState };
  // Read the current greeting. This is a SETTING, and a setting is just durable
  // Store state under a `settings/` prefix: the extension owns its editing
  // surface in-app, so it reads and writes the value through these two requests
  // rather than declaring a host-rendered schema.
  'greeting.get': { params: Record<string, never>; response: { greeting: string } };
  // Replace the greeting and persist it to the Store; returns the new value.
  'greeting.set': { params: { greeting: string }; response: { greeting: string } };
  // Ask a worker to describe itself. The surface cannot address a worker, so it
  // names one and asks the HOST daemon, which forwards on the worker leg
  // (`WorkerRequests['inspect']`) and hands the answer back. `worker` is null to
  // let the host daemon pick the first connected one.
  'worker.inspect': { params: { worker: string | null }; response: WorkerInspectResult };
  // The latest heartbeat from each worker running our worker bundle, right now.
  // Same shape as the `worker.heartbeats` event below on purpose: a view reads
  // this once at mount for its starting picture and then takes the event, which
  // is the whole set again rather than a delta. Nothing is queued across a
  // disconnect, so without the read a freshly-mounted view would show nothing
  // until the next beat.
  'worker.heartbeats': { params: Record<string, never>; response: WorkerHeartbeat[] };
}

// One worker's most recent heartbeat, as a surface sees it. `worker` is what the
// HUB knew and the worker did not send: a spoke's subscribe handler receives the
// payload alone, with no envelope naming who published, so the host daemon folds
// the sending connection's worker id in. Routing facts a surface needs are put
// there deliberately, by the one bundle that has them.
export interface WorkerHeartbeat {
  worker: string;
  hostname: string;
  at: string;
}

// What `worker.inspect` resolves to, and the shape of every operation here whose
// failure is part of its contract. "No worker is running our bundle yet" is an
// EXPECTED outcome on a fresh install, not a fault, so it is a VALUE the caller
// must branch on — its own discriminated result, whose failure arm carries a
// plain message. Throwing instead would be wrong twice over: the caller could
// ignore it, and the shared boundary would report a routine state to the log,
// telemetry, and the error stream as though something had broken.
//
// The other half of the rule still applies underneath: an UNEXPECTED fault (the
// worker's own responder throwing, the connection dropping mid-call) is a
// rejection, and the caller's `await host.request(...)` rejects with it. So a
// caller of this topic handles both — `ok: false` for the outcome it was told
// about, a catch for the fault it was not.
export type WorkerInspectResult =
  | { ok: true; report: WorkerInspectReply }
  | { ok: false; error: string };

// What the worker daemon reports back about the worker it runs on. The shape is
// shared so the host, the worker, and the surface all agree on it.
export interface WorkerInspectReply {
  hostname: string;
  platform: string;
  cwd: string;
  // A short listing of the worker's cwd — something only code NEXT TO the
  // worker's files could produce.
  entries: string[];
}

// ── The surface ⇄ host-bundle leg: events ──────────────────────────────────
//
// Fire-and-forget announcements the host daemon publishes to its surfaces. A
// surface subscribes and re-renders.
export interface SurfaceEvents {
  // Emitted whenever the persisted state changes (a bump, a note edit, a
  // scheduler tick). A surface keeps its view live off this instead of polling.
  'state.changed': HelloState;
  // Emitted when the greeting setting changes, so an already-open surface
  // reflects the edit live without re-requesting.
  'greeting.changed': { greeting: string };
  // The whole heartbeat set again, every time it changes — a worker beat, or a
  // worker's connection went away. It carries the full picture rather than a
  // delta so a subscriber can simply replace what it is showing, and so the
  // event and the one-shot read above are the same shape with no merge rule to
  // get wrong.
  'worker.heartbeats': WorkerHeartbeat[];
}

// ── The host-bundle ⇄ worker leg: requests ─────────────────────────────────
//
// What the host daemon asks a worker daemon. It addresses one connection at a
// time (`host.request(topic, { worker: id })`); the worker daemon answers with
// an ordinary `host.respond`, and the platform owns the correlation and the
// timeout, so neither side mints request ids or matches replies by hand.
export interface WorkerRequests {
  // Describe the worker this daemon runs on.
  'inspect': { params: Record<string, never>; response: WorkerInspectReply };
  // Report this daemon's current liveness, on demand. The same fact the
  // `heartbeat` event below pushes, PULLABLE: the host bundle asks for it when
  // it has just loaded and has no beats yet, instead of waiting out an interval
  // it does not control. Whatever an extension keeps from an event stream needs
  // a way to be asked for, because a stream tells you about changes and says
  // nothing about the state you started in.
  'beat': { params: Record<string, never>; response: { hostname: string; at: string } };
}

// ── The host-bundle ⇄ worker leg: events ───────────────────────────────────
//
// What a worker daemon publishes to the host bundle. A worker's publish reaches
// its ONE peer — the host bundle — and no one else; getting it to a surface is
// the hub's job (it re-publishes as `SurfaceEvents['worker.heartbeat']`).
export interface WorkerEvents {
  // An unsolicited liveness push: nothing asked for it.
  'heartbeat': { hostname: string; at: string };
}

// ── The public, versioned endpoint other extensions may call ───────────────
//
// Registered by the HOST bundle with `host.public.respond('count.get', 1, …)`
// and reachable by ANY other extension via
// `host.extensions('hello-world')` → `.request('count.get')` — or by a running
// agent via the core `frontier.bus_call` MCP tool. Only what is registered
// there crosses the boundary; the private topics above do not.
export interface PublicApi {
  'count.get': { version: 1; params: Record<string, never>; response: { count: number } };
}
