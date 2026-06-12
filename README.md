# Hello World — the reference Frontier extension

This is the canonical example extension. It does one small thing in each of Frontier's capabilities, every capability in its own clearly-captioned section, so you can read it top to bottom and see exactly how a real extension is wired. Nothing here is load-bearing for any real workflow — the point is the shape, not the feature. If you're about to build a Frontier extension, read this repo first, then keep it open beside yours.

The full contract is [`frontier/docs/EXTENSIONS.md`](https://github.com/frontierengineer/frontier/blob/main/docs/EXTENSIONS.md) and the platform overview is [`docs/ARCHITECTURE.md`](https://github.com/frontierengineer/frontier/blob/main/docs/ARCHITECTURE.md). This README is the tour; those are the spec.

## The three tiers (and why the server is the hub)

A Frontier extension is up to three halves, each in its own directory, each running in a different process. They never share memory — they talk over channels — and the **server is the hub the other two reach through**:

- **`worker/` — next to the files.** A daemon-side component that runs on *every connected machine*, right next to that machine's files. It's where you read the local filesystem, the hostname, the working directory — anything that only makes sense beside the machine. It has no UI and no bus; the only thing it can talk to is its own `server/` code, over a raw message channel. To make something show up in the UI, it sends to the server, and **the server re-publishes it to the UIs** — a worker reaches the user by going through its server.
- **`server/` — the coordinator, the persistence, the hub.** Runs once in the host process. It's the only half that can talk to *both* the UI (over the bus) and the worker (over the worker channel), so everything routes through it. It owns the durable Store, declares Config, registers schedules, answers the UI, exposes a public endpoint other extensions can call, and brokers the worker channel. When in doubt, logic lives here.
- **`ui/` — what the user sees.** The browser-side half: views (tabs), sidebar sections, commands, modals, welcome tiles. It keeps no durable state of its own — it asks the server over the bus and renders what comes back, staying live by subscribing to the server's events.

```
ui/index.tsx  ──bus.extension──►  server/index.ts  ──workers.channel──►  worker/index.ts
(the browser)  ◄──────────────     (THE HUB)        ◄──────────────────   (the daemon)
```

Two more host-side capabilities round it out, each its own directory because each is a separate plug-in point the host invokes at a different moment: **`mcp/`** contributes tools an AI agent can call during a session, and **`hooks/`** runs code at defined moments in a core flow (here, just before a session dispatch). They share no memory with `server/`; they coordinate through a service both hold — the Store.

## Capability → file → what to look at

| Capability | File | Look at |
|---|---|---|
| **Store** (durable per-extension state) | `server/index.ts` | §1 — `readState`/`writeState`; one JSON blob, the extension owns serialization |
| **Data migration** across schema versions | `server/index.ts` | §2 — `migrate(fromVersion, toVersion, store)` + the `dataVersion` in `extension.json` and `meta/schema_version` marker |
| **Config** (user-editable setting) | `server/index.ts` | §3 — `config.declare` + `config.watch`; the host renders the input, the extension only reads |
| **Scheduler** (host-managed timer) | `server/index.ts` | §4 — `scheduler.register` with an `interval`; a pure timer holds no slot |
| **Private bus** (UI ⇄ its own server) | `server/index.ts` / `ui/index.tsx` | server §5 (`bus.extension.respond`/`publish`) and the `useHelloState` hook in the UI (`request`/`subscribe`) |
| **Public bus** (one versioned cross-extension endpoint) | `server/index.ts` | §6 — `bus.public.respond('count.get', 1, …)`; reachable via `bus.extensions('hello-world')` or the `frontier.bus_call` tool |
| **Worker channel** (server ⇄ daemon, correlated) | `server/index.ts` / `worker/index.ts` | server §7 (the `cid` correlation helper + the heartbeat fan-out) and the whole `worker/index.ts` |
| **Worker → server → bus → all UIs** fan-out | `worker/index.ts` → `server/index.ts` → `ui/index.tsx` | the worker's `beat()` push → server §7 re-publish → the UI's `worker.heartbeat` subscription |
| **MCP tool** (an agent can call it) | `mcp/index.ts` | `mcp.registerTool({ name: 'bump', … })`; exposed to the agent as `hello-world.bump` |
| **Hook** (run at a moment in a flow) | `hooks/index.ts` | `hooks.register({ hook: HOOKS.SESSION_PRE_DISPATCH_V1, blocking: false, … })` |
| **View** (a tab the extension owns) | `ui/index.tsx` | `ui.views.register` + the `HelloView` component |
| **Sidebar** section | `ui/index.tsx` | `ui.sidebar.register` + `HelloSidebar` |
| **Command** with a default keybinding | `ui/index.tsx` | `ui.commands.register({ id: 'hello-world.open', defaultKey: 'ctrl+alt+h', … })` |
| **Modal** (host-rendered prompt) | `ui/index.tsx` | `ui.modals.prompt` in `editNote` |
| **Welcome tile** | `ui/index.tsx` | `ui.welcome.contribute` |
| **Prefs** (device-local UI state) | `ui/index.tsx` | `ui.prefs.get`/`set` for the sidebar collapsed flag — never synced, never in the Store |
| **Shared typed message contract** | `messages.ts` | the `Requests` / `Events` / `PublicApi` / `WorkerMsg` types both halves import |

## The registration shape

Every capability exports a single `register(provider)` and asks the provider for the version of the interface it targets — `provider.version(1)`. The interface *is* the version: a breaking change ships a new `version(2)` overload returning a new interface, while v1 keeps working. The host calls `register` once at load; every subscription, responder, tool, schedule, and config declaration you make is tracked and torn down automatically on reload — you only write a `deregister(...)` for things the host can't see (a timer, an open connection, an in-flight promise).

## How types resolve (important for a standalone repo)

Every capability imports the host contract as `import … from '../../types'` — the exact specifier an installed extension uses. In production the host copies your extension into `<FRONTIER_DIR>/extensions/<id>/` and writes a `types.ts` shim one level up (a sibling of every extension), so `../../types` from `<id>/server/index.ts` resolves to `extensions/types.ts`. Your extension's *own* shared file, `messages.ts`, sits at your extension root and is imported as `../messages` (one level up from a capability) — note the different depth: `../../types` is the host's file two levels up, `../messages` is your file one level up.

This repo is a flat, standalone extension (the `extension.json` is at the root), so there is no host beside it and `../../` from a capability would point above the repo. To stay byte-identical to an installed extension, the contract is **vendored at the repo root** — [`types.ts`](./types.ts) (a verbatim copy of the host's `backend/extensions/types.ts`) and [`workspaceTypes.ts`](./workspaceTypes.ts) (its one dependency). The `import type` lines are type-only, so esbuild erases them from the shipped `ui`/`worker` bundles — nothing vendored ends up at runtime. To keep current with the host, re-copy those two files when the API moves.

Because TypeScript and esbuild won't remap a relative specifier, `npm run verify` reproduces the production directory nesting in a throwaway `.verify/` mirror (the vendored `types.ts` as a sibling of an `<id>` dir that symlinks this repo) and runs the checks from there — so `../../types` resolves *exactly* as the host resolves it, with no edits to the source.

## Verifying

```
npm install      # dev-only: TypeScript, esbuild, and @types for the local checks
npm run verify   # typecheck (host-side + ui) against the production-nested mirror, then esbuild every entry the way the host's bundler does
```

`npm run verify` is the full gate. `npm run build:check` runs just the esbuild pass. None of this is needed to *use* the extension — the Frontier host builds the real bundles itself when it loads the extension; these scripts only let you confirm it compiles and bundles before you publish.

## Publishing

Publishing is open and unreviewed-by-humans: tag a release and the marketplace indexer picks it up. See the registry's [`PUBLISHING.md`](https://github.com/frontierengineer/extensions/blob/main/PUBLISHING.md).

```
git tag v1.0.0 && git push origin v1.0.0
```

[`.github/workflows/release.yml`](./.github/workflows/release.yml) packs the extension into `extension.tgz` (minus `.git`, `.github`, `node_modules`, `data`, and the local-only `.verify`) and attaches it to a GitHub release; the registry then scans that exact tarball, pins its sha256 into `index.json`, and it's installable from the Extensions view's Marketplace tab.
