# Hello World

A tiny demo extension that says hello and shows a live greeting inside Frontier.

Hello World is the friendly first thing to install when you want to see what a Frontier extension feels like. It owns its whole content surface — a single page that greets you, lets you set a short note, and shows a counter and live status that update on their own in real time — a gentle, no-stakes way to watch an extension come to life in Frontier. Nothing here touches your work; it's a self-contained little hello you can install, play with, and remove any time.

<!-- screenshot: the Hello World extension showing the greeting, the counter, the editable note, and live worker heartbeats -->

## Features

- A Hello World extension: one page that owns its content, with a greeting and a short note you can edit
- A counter and live status that refresh by themselves, so you can see the extension staying in sync
- A "Set note…" button backed by an **action** — the same thing the AI can do for you (just ask it to set the note), so you can watch a single operation work from both a button and the assistant
- A one-key **action** (in the command palette, on a default keybinding) to edit the note from anywhere
- A live line per connected worker showing it's alive, and an on-demand round-trip that asks one of them to describe itself

## Install

Install Hello World from the **Extensions → Marketplace** tab in Frontier: find Hello World, click Install, and it's added to your workspace in one click (Frontier verifies the download before installing). No setup or configuration needed.

## How it's built (for authors)

Hello World is the reference extension — the smallest complete example to copy when starting your own. Read `surface/index.tsx` alongside these notes.

**`register()` is declaration only.** A surface bundle's `register()` names the components the extension contributes and nothing else — there is no logic in it. Hello World declares just two:

- **an application** (`surface.application.register`) — the one component that owns the whole content rect. Its `mount(context)` renders the view.
- **daemons** (`surface.daemons.register`, each with a declared id; one is the norm) — the headless, always-on components. Declare one only when the extension has always-on logic or registrations whose closures must outlive any visible surface. Everything an action or option source does belongs here, because the daemon keeps running while the extension is enabled — so an action invoked from the palette or called by the assistant reaches its `run()` with no application open. A purely visual extension declares no daemon at all.

**Logic lives in a mount context, never in `register()`.** Each component gets its capability from its own mount context, scoped to the component's lifetime:

- the daemon's `mount(context)` is where the background logic lives. Its context is a `SurfaceDaemonContext`: the flat `SurfaceContext` (see below) plus the registration surfaces (`context.actions` and `context.optionSources`). Hello World registers both of its actions here.
- the application's `mount(context)` renders the UI. Its context is a `SurfaceApplicationContext`: that same flat `SurfaceContext`, plus the container, the surface capability vector, and the application's `lifecycle` — the activation pair (`onActivate`/`onDeactivate`: the application starting and being shut down, the launcher X) and the focus pair (`onFocus`/`onBlur`: holding or yielding the foreground; a blurred application stays active and warm). Sidebars and overlays carry focus-only lifecycles — they are always active while the extension is enabled. (Mount contexts are named `{Realm}{UseCase}Context` — the name says which realm mounted you and as what.)

**The mount context is a flat `SurfaceContext`.** Every runtime capability sits directly on the context — there is no `.services.` hop. It carries `host` (this bundle's one connection, to the extension's host bundle), the durable `store`, the `workers`/`workspaces`/`sessions` fleet, and the surface helpers an extension reaches for constantly — `localSettings` (device-local UI state) and the surface-entity controls — `applications`, `sidebars`, `overlays`, and `modals` (host-rendered prompt/confirm dialogs). Hello World talks to its host bundle through `context.host`, reads connected workers through `context.workers`, and opens its greeting dialog through `context.modals.prompt`.

**Actions, not commands — and every action is in the command palette.** There is no separate "command" concept: an operation is an `ActionDefinition` registered on `context.actions`, and every action appears in the command palette automatically — so its input schema must always be modal-renderable. Hello World shows the two shapes:

- `hello-world.edit-note` has **`input: null`** — a zero-argument action. The palette runs its `run()` directly (no generated modal), and it reads there as a plain command: `category` groups it and `defaultKey` seeds a keybinding. This is the shape to reach for when you want a keybound command.
- `hello-world.set_note` has an **`input` schema** — the host generates a modal from its fields (including a live `workspace` picker), and that one declaration is also an agent tool (`frontier.run_action`) and a schedulable unit. Write its `description` for the model.

**`mount()` returns an object, never `null`.** Every `mount()` (application, sidebar, daemon) returns `{ dispose?: () => void }`: an object is required — an accidental `void`/`null` return is a type error — `dispose` is optional, and `{}` is the "nothing to tear down" handle. Hello World's surface daemon returns `{}` (its actions deregister with it); its application returns `{ dispose }` to unmount React.

**All three realms read the same way.** The surface model above — `register()` names components, logic lives in each component's `mount()`, and `mount()` returns the teardown — is the shape of the **host** and **worker** realms too, so read `host/index.ts` and `worker/index.ts` next to `surface/index.tsx` and they mirror each other. Each realm's `register()` is declaration-only and names top-level components: the host realm registers its **daemons** (`h.daemons.register(...)`, each with a declared id; one is the norm), and the worker realm takes up to three kinds — agent **runtimes** (`w.runtime.register`), **workspaces** (`w.workspace.register`), and the general-purpose **daemons** (`w.daemons.register`), exactly parallel to the surface's application/sidebar/daemons (Hello World's worker contributes one daemon). Every component's `mount()` receives a **flat**, `{Realm}{UseCase}Context`-named context with every capability directly on it (`context.store`, `context.scheduler`, `context.host`, `context.mcp` on the host daemon; `context.host`, `context.execute`, `context.modules` on the worker daemon — no `.services.` hop) and returns the same optional `dispose`. There is no separate top-level unload hook in any realm: Hello World's worker daemon returns a `dispose` that clears its heartbeat interval, and its host daemon returns an empty handle because everything it made is platform-tracked — the single teardown path each realm has, captured in `mount` and closed over by `dispose`.

**Hub and spoke: every bundle holds exactly one connection, and it is to the host bundle.** `context.host` is that connection, and it has four verbs on it — `request`/`respond` and `publish`/`subscribe`. A surface never addresses a worker and a worker never addresses a surface; there is no selector, no target, and no envelope on a spoke, because there is only ever one peer to mean. In the **host** bundle the same member is the hub end (`HostHub`): it addresses *connections*, not realms — `'all'`, `{ id }`, `{ device }`, or `{ worker }` — a responder there also receives the `ExtensionConnection` that asked, `requestAll` fans one question out and keeps every answer, and `connections(selector)` / `onConnectionsChanged` are its live view of who is attached. So anything crossing between a surface and a worker is two legs, both written in the host bundle, and `messages.ts` names the two legs apart for that reason.

Hello World's `host/index.ts` §8 is the whole of that, in both directions:

- **A surface asks a worker something.** It asks the hub `worker.inspect`, naming a worker or `null`; the hub resolves that to one connection and forwards it as `inspect` with a `{ worker }` selector. Resolving there is not politeness — a selector must name *exactly one* connection, so the hub is the only place that can turn "whichever worker" into a legal one.
- **A worker announces something.** Each worker daemon publishes `heartbeat` to the hub, which folds the sending connection's worker id in (a spoke's subscriber receives the payload alone, so a routing fact has to be put there by whoever knew it) and fans the set out to every surface.

**Whatever you keep from a stream, make it askable.** The hub *keeps* the latest heartbeat per worker rather than only relaying it, and that shapes three things worth copying. It serves the set on request and announces the whole set again on every change — same shape both ways, so a view reads once at mount and then replaces, with no merge rule to get wrong. It prunes a worker from the set when `onConnectionsChanged` says that connection is gone, because a dropped connection is the only notice of that there is. And it *asks* rather than waits: the worker realm answers a `beat` request as well as pushing one, so a host bundle that has just reloaded primes itself with `requestAll('beat', 'all')` instead of showing an empty list for a full interval while workers beat on a schedule it does not control. A stream tells you about changes and says nothing about the state you started in.

**Declare your realms in `extension.json`.** The `realms` field names, per realm, exactly what the extension contributes:

```json
"realms": {
  "surface": { "applications": ["hello-world"], "sidebars": [], "daemons": ["hello-world"] },
  "host":    { "mcpTools": ["bump"], "voice": false, "daemons": ["hello-world"] },
  "worker":  { "runtimes": [], "workspaces": [], "daemons": ["hello-world"] }
}
```

Hello World fills all three: a `surface` bundle with one application and a daemon (no docked sidebars); a `host` bundle contributing the `bump` MCP tool (and no voice override); and a `worker` bundle whose daemon carries the heartbeat/inspect halves (it declares no runtimes and no workspaces). `realms` is required and is the source of truth — a realm you don't declare is not loaded even if its directory exists, and a registration your declaration doesn't cover is flagged as **drift** in the Extensions view. A realm you ship no bundle for is simply **absent** from `realms` (this is the one place where a missing key, not `null`, is how you say "not declared"), and at least one realm entry must be present.

A few conventions this reference leans on, worth copying:

- **`localSettings` is storage, not a signaling channel — there is no `watch`.** It holds device-local UI state (column widths, expanded sets) read on mount and written on change. When two components must react to each other live, they do it over `context.host` events; durable state that must notify uses `store.watch`. A cross-realm hand-off (an action's `run()` in the surface daemon telling the open application to do something) writes the value to `localSettings` for read-at-mount **and** publishes an event for the live case — the consumer reads at mount plus subscribes.
- **Live signaling, not a mailbox.** `publish`/`subscribe` is ordered on the one connection, delivered only to connections that subscribed to that type, and never queued or retried across a disconnect. That is why every live view here is a `request` for the current value *and* a `subscribe` for the changes: the one-shot read is what gives a freshly-mounted component its starting state. Durable state belongs in the Store.
- **An expected failure is a value; an unexpected fault is a throw.** Both halves are load-bearing. "No worker is running our bundle yet" is an ordinary state on a fresh install, so `worker.inspect` resolves with its own discriminated result (`{ ok: false, error }`) and the caller must branch — throwing would let a caller ignore it *and* would have the shared boundary report a routine state to the log, telemetry, and the error stream as though something had broken. A worker's responder actually throwing, or a call timing out, is a fault: it rejects, the boundary reports it once, and the caller's `catch` shows it. The one thing that is always wrong is catching a failure and rendering as though it succeeded — see `WorkerInspector` in `surface/index.tsx`, which handles both paths and neither silently.
- **Contract-shaped literals set every field explicitly — a value or `null`, never by omission.** A definition (an `ActionField`, an `ActionDefinition`, a `PromptField`, an application's `requires`) fills each optional field with an explicit value or `null`, so the shape reads completely at the call site rather than relying on absent keys. A `SurfaceRequirement`'s per-axis arrays follow the same spirit: an empty `[]` means "unconstrained on this axis", never a missing key.
- **Store reads return a wrapper.** `store.getString(key)` / `getBytes(key)` resolve to `{ value }` (null when absent) and `store.list(prefix)` to `{ keys }`; the writers take a single options object (`store.putJson({ key, value })`). Read `(await store.getString(k)).value`, not the bare result.
- **Migrate your own Store data.** The host stores raw bytes and attaches no meaning to them, so there is no manifest field and no host-called `migrate()` hook: an extension steps its own format forward inside its own Store, gating its responders on that startup work. `host/index.ts` §2 is the worked pattern.

## How types resolve

Every realm imports the contract as `../../types`, and that depth is deliberate: once installed, an extension's directory sits inside the host's `extensions/` directory, and the host writes a `types.ts` shim there as a **sibling of every installed extension**. So from `host/index.ts`, `../../types` is that shim, and it re-exports the one self-contained contract file (`interfaces/extension.ts`). Nothing is vendored into this repo, which is the point: there is no second copy of the contract here to drift out of date. The other import depth, `../messages`, is one level up — this extension's own shared file at its own root.

To typecheck the tree the way it actually ships, run:

```sh
node typecheck.mjs                        # expects a frontier checkout at ../frontier
FRONTIER_REPO=/path/to/frontier node typecheck.mjs
```

`typecheck.mjs` reproduces the installed layout in a temp directory — a copy of these sources next to a `types.ts` that re-exports the checkout's contract — and runs `tsc --noEmit` once per realm, with the same libs and aliases each realm is really compiled against (node for `host/` and `worker/`; DOM, JSX, React and `@frontierengineer/ui` for `surface/`). It stages rather than typechecking in place because `../../types` is a *relative* specifier: no tsconfig `paths` entry can redirect it, so the only faithful check is to put the code in the layout that specifier describes. It reads the contract from the checkout every time, so it can never go green against a stale copy.
