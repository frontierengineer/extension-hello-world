// ─────────────────────────────────────────────────────────────────────────
// messages.ts — the shared, typed message contract for this extension.
//
// The bus is untyped JSON on the wire; this file is the COMPILE-TIME contract
// the two halves agree on. `server/index.ts` (host) and `ui/index.tsx`
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
// not here. See WorkerMsg at the bottom for that shape.)
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
  // Replace the greeting and persist it via config.set; returns the new value.
  'greeting.set': { params: { greeting: string }; response: { greeting: string } };
  // Ask the server to round-trip the worker channel: server sends a request to
  // its worker component on `machine`, the component answers from next to the
  // files, and the server returns that reply. Demonstrates request/response
  // CORRELATION layered over the raw channel.
  'worker.inspect': { params: { machine: string }; response: WorkerInspectReply };
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
  // The headline fan-out: the worker PUSHED a heartbeat to the server, and the
  // server re-published it here so EVERY connected UI sees it. This is the
  // "a worker reaches the UI by going through its server" path, made visible.
  'worker.heartbeat': { machine: string; hostname: string; at: string };
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

// ── Worker channel protocol (server ⇄ worker, NOT the bus) ─────────────────
//
// The worker channel carries opaque JSON; this is OUR envelope over it. Every
// message has a `kind`; requests/replies carry a `cid` (correlation id) so the
// server can match a reply to the request it sent (the platform channel has no
// built-in correlation — we add it). `heartbeat` is unsolicited: the worker
// pushes it on its own, with no request to answer.
export type WorkerMsg =
  // server → worker: please inspect the machine; answer with cid.
  | { kind: 'inspect.req'; cid: string }
  // worker → server: the answer to inspect.req with the matching cid.
  | { kind: 'inspect.res'; cid: string; reply: WorkerInspectReply }
  // worker → server: an unsolicited push (no cid) the server fans out to UIs.
  | { kind: 'heartbeat'; hostname: string; at: string };
