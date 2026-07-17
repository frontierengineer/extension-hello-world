// ─────────────────────────────────────────────────────────────────────────
// messages.ts — the shared, typed message contract for this extension.
//
// The bus is untyped JSON on the wire; this file is the COMPILE-TIME contract
// the two halves agree on. `server/index.ts` (host) and `surface/index.tsx`
// (browser) both import these types so a request and its responder, or an
// event and its subscriber, can't drift out of shape without a type error.
//
// Three groups, matching the three things that travel between UI and server
// on this extension's PRIVATE channel (`bus.extension.*`):
//   • Requests — UI asks, server answers (request ⇄ respond).
//   • Events   — server announces, UI (and other server subscribers) listen.
//   • Public   — the ONE versioned endpoint other extensions may call.
//
// (The worker↔server channel is a different transport — a raw JSON link, not
// the bus — so its protocol lives in its own section of server/worker code,
// not here. See WorkerRequest/WorkerPush at the bottom for those shapes.)
// ─────────────────────────────────────────────────────────────────────────

// The single piece of durable state this extension keeps: a counter the user
// bumps from the UI or an agent bumps via the MCP tool, plus a free-text note.
export interface HelloState {
  count: number;
  note: string;
  // ISO timestamp of the last mutation — proves the Store round-trips.
  updatedAt: string;
}

// ── Requests: UI → server (bus.extension.request ⇄ bus.extension.respond) ──
//
// Each key is a request topic; `params` is what the UI sends, `response` is
// what the server's responder returns. This is the private request/respond
// surface — only this extension's own UI can call it.
export interface Requests {
  // Read the current persisted state (the counter + note).
  'state.get': { params: Record<string, never>; response: HelloState };
  // Bump the counter by `by` (default 1) and persist; returns the new state.
  'state.bump': { params: { by?: number }; response: HelloState };
  // Replace the note text and persist; returns the new state.
  'note.set': { params: { note: string }; response: HelloState };
  // Read the current greeting. This is a SETTING (not app state): it lives in
  // the retained per-extension key/value config store, not the Store. The UI
  // owns its editing surface in-app now (there is no host settings panel), so it
  // reads and writes it through these two requests rather than declaring a
  // host-rendered schema.
  'greeting.get': { params: Record<string, never>; response: { greeting: string } };
  // Replace the greeting and persist it to the Store; returns the new value.
  'greeting.set': { params: { greeting: string }; response: { greeting: string } };
}

// What the worker component reports back about the machine it runs on. The
// shape is shared so server, worker, and UI all agree on it.
export interface WorkerInspectReply {
  hostname: string;
  platform: string;
  cwd: string;
  // A short listing of the worker's cwd — something only code NEXT TO the
  // machine's files could produce.
  entries: string[];
}

// ── Events: server → UI (bus.extension.publish → bus.extension.subscribe) ──
//
// Fire-and-forget announcements. The UI subscribes and re-renders; any
// server-side subscriber would receive them too.
export interface Events {
  // Emitted whenever the persisted state changes (a bump, a note edit, a
  // scheduler tick). The UI keeps its view live off this instead of polling.
  'state.changed': HelloState;
  // Emitted when the greeting setting changes, so an already-open UI (or another
  // surface) reflects the edit live without re-requesting. The server publishes
  // it on every greeting.set.
  'greeting.changed': { greeting: string };
}

// ── Public: this extension's ONE cross-extension endpoint (versioned) ──────
//
// Registered with `bus.public.respond('count.get', 1, …)` and reachable by
// ANY other extension via `bus.extensions('hello-world').request('count.get')`
// — or by a running agent via the host `frontier.bus_call` MCP tool. Only
// what's registered here is visible across the boundary; the private Requests
// above are not.
export interface PublicApi {
  'count.get': { version: 1; params: Record<string, never>; response: { count: number } };
}

// ── Worker channel protocol (surface/host ⇄ worker, NOT the bus) ───────────
//
// The platform channel carries opaque JSON; these are OUR payloads over it.
// Any of this extension's surface or host code addresses the worker daemon
// with a target — `{ machine }` here (machine-scoped inspection), or
// `{ reservationId }` for slot-scoped work (the daemon reads the reservation
// off its delivery envelope). The link speaks two dialects, and the split
// here mirrors them:
//   • WorkerRequest rides `channel.request(target, …)` and is answered by the
//     worker's `channel.onRequest` handler — the PLATFORM owns the correlation
//     and the timeout, so no request id appears in the payload.
//   • WorkerPush rides plain `send()` — unsolicited, fire-and-forget; every
//     channel subscriber (each open UI, the host daemon) receives it with an
//     envelope naming the sending machine.
// Branch on `kind` to grow either side of the protocol.
export type WorkerRequest =
  // caller → worker: please inspect the machine; the reply is the handler's
  // return value (a WorkerInspectReply).
  { kind: 'inspect' };
export type WorkerPush =
  // worker → host bundle: an unsolicited push the host bundle fans out to UIs.
  { kind: 'heartbeat'; hostname: string; at: string };
