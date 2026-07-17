// ─────────────────────────────────────────────────────────────────────────
// messages.ts — the shared, typed message contract for this extension.
//
// The bus is untyped JSON on the wire; this file is the COMPILE-TIME contract
// the two halves agree on. `server/index.ts` (host) and `surface/index.tsx`
// (browser) both import these types so a request and its responder, or an
// event and its subscriber, can't drift out of shape without a type error.
//
// Three groups, matching the three things that travel on this extension's
// PRIVATE bus (`bus.extension.*`) — the ONE bus every realm is on, worker
// daemons included (a call reaches a worker by naming a target):
//   • Requests — a caller asks, a responder answers (request ⇄ respond). Most
//     responders live in the host daemon; `worker.inspect` is answered by the
//     WORKER daemon, so callers address it with a target.
//   • Events   — announced fire-and-forget; subscribers listen. Most come from
//     the host daemon; `worker.heartbeat` is published by the worker daemon,
//     and its delivery envelope names the machine it came from.
//   • Public   — the ONE versioned endpoint other extensions may call.
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

// ── Worker traffic (surface/host ⇄ worker, on the SAME one bus) ─────────────
//
// There is one bus across all three realms; worker traffic is just bus
// traffic with a target. Any of this extension's surface or host code
// addresses the worker daemon by passing `{ target }` in the call's options —
// `{ machine }` here (machine-scoped inspection), or `{ reservationId }` for
// slot-scoped work (the daemon reads the reservation off its delivery
// envelope). The two bus dialects carry the two directions:
//   • 'worker.inspect' rides `bus.extension.request(type, payload, { target })`
//     and is answered by the worker daemon's `respond('worker.inspect', …)` —
//     the PLATFORM owns the correlation and the timeout, so no request id
//     appears in the payload (WorkerInspectReply is the responder's return).
//   • 'worker.heartbeat' rides the worker's plain `publish()` — unsolicited,
//     fire-and-forget; every surface/host subscriber receives it with an
//     envelope naming the sending machine.
// The bus type names the message, so the payloads carry no `kind` field.
export type WorkerHeartbeat =
  // worker → every subscriber: an unsolicited liveness push.
  { hostname: string; at: string };
