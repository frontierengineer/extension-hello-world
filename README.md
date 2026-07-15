# Hello World

A tiny demo extension that says hello and shows a live greeting inside Frontier.

Hello World is the friendly first thing to install when you want to see what a Frontier extension feels like. It owns its whole content surface — a single page that greets you, lets you set a short note, and shows a counter and live status that update on their own in real time — a gentle, no-stakes way to watch an extension come to life in Frontier. Nothing here touches your work; it's a self-contained little hello you can install, play with, and remove any time.

<!-- screenshot: the Hello World extension showing the greeting, the counter, the editable note, and live worker heartbeats -->

## Features

- A Hello World extension: one page that owns its content, with a greeting and a short note you can edit
- A counter and live status that refresh by themselves, so you can see the extension staying in sync
- A "Set note…" button backed by an **action** — the same thing the AI can do for you (just ask it to set the note), so you can watch a single operation work from both a button and the assistant
- A one-key **action** (in the command palette, on a default keybinding) to edit the note from anywhere
- Live worker heartbeats streamed from a connected machine, to show the full round-trip

## Install

Install Hello World from the **Extensions → Marketplace** tab in Frontier: find Hello World, click Install, and it's added to your workspace in one click (Frontier verifies the download before installing). No setup or configuration needed.

## How it's built (for authors)

Hello World is the reference extension — the smallest complete example to copy when starting your own. Read `surface/index.tsx` alongside these notes.

**`register()` is declaration only.** A surface bundle's `register()` names the components the extension contributes and nothing else — there is no logic in it. Hello World declares just two:

- **an application** (`surface.application.register`) — the one component that owns the whole content rect. Its `mount(host)` renders the view.
- **a daemon** (`surface.daemon.register`) — the headless, always-on component. Declare one only when the extension has always-on logic or registrations whose closures must outlive any visible surface. Everything an action, option source, or status-bar item does belongs here, because the daemon keeps running while the extension is enabled — so an action invoked from the palette or called by the assistant reaches its `run()` with no app open. A purely visual extension declares no daemon at all.

**Logic lives in a mount context, never in `register()`.** Each component gets its capability from its own mount context, scoped to the component's lifetime:

- the daemon's `mount(ctx)` is where the background logic lives. `ctx` **is** a `SurfaceComponentContext` (see below), plus the registration surfaces (`ctx.actions`, `ctx.optionSources`, `ctx.statusBar`). Hello World registers both of its actions here.
- the app's `mount(host)` renders the UI. `host` is that same `SurfaceComponentContext`, plus the container, the warm-keep `lifecycle`, and the host-chrome verbs.

**The mount context is a flat `SurfaceComponentContext`.** Every runtime capability sits directly on the context — there is no `.services.` hop. It carries the `bus` (talk to the extension's own server), the durable `store`, the `workers`/`workspaces`/`sessions` fleet, and the surface helpers an extension reaches for constantly — `localSettings` (device-local UI state), `modals` (host-rendered prompt/confirm dialogs), `navigate`, and the `sidebar`/`overlay` controls. Hello World talks to its server through `host.bus`, reads connected machines through `host.workers`, and opens its greeting dialog through `host.modals.prompt`.

**Actions, not commands — and every action is in the command palette.** There is no separate "command" concept: an operation is an `ActionDefinition` registered on `ctx.actions`, and every action appears in the command palette automatically — so its input schema must always be modal-renderable. Hello World shows the two shapes:

- `hello-world.edit-note` has **`input: null`** — a zero-argument action. The palette runs its `run()` directly (no generated modal), and it carries the palette fields a command used to have: `category` groups it and `defaultKey` seeds a keybinding. This is the direct successor to a keybound command.
- `hello-world.set_note` has an **`input` schema** — the host generates a modal from its fields (including a live `workspace` picker), and that one declaration is also an agent tool (`frontier.run_action`) and a schedulable unit. Write its `description` for the model.

**`mount()` returns an object, never `null`.** Every `mount()` (app, sidebar, daemon) returns `{ dispose?: () => void }`: an object is required — an accidental `void`/`null` return is a type error — `dispose` is optional, and `{}` is the "nothing to tear down" handle. Hello World's daemon returns `{}` (its actions deregister with it); its app returns `{ dispose }` to unmount React.

**All three realms read the same way.** The surface model above — `register()` names components, logic lives in each component's `mount()`, and `mount()` returns the teardown — is now the shape of the **host** and **worker** realms too, so read `host/index.ts` and `worker/index.ts` next to `surface/index.tsx` and they mirror each other. Each of those bundles' `register()` is declaration-only and registers a single daemon (`h.daemon.register(...)` in `host/`, `w.daemon.register(...)` in `worker/`); all of its logic and capability live inside that daemon's `mount()`. That `mount()` receives a **flat** host — a `HostDaemonHost` or `WorkerDaemonHost` with every capability directly on it (`host.store`, `host.scheduler`, `host.channel(machine)`, `host.mcp`; `host.execute`, `host.importWorker` — no `.services.` hop) — and returns the same optional `dispose`. There is no separate top-level unload hook in any realm: Hello World's host daemon returns a `dispose` that settles its in-flight worker requests, and its worker daemon returns one that clears its heartbeat interval — the single teardown path each realm has, captured in `mount` and closed over by `dispose`.

**Declare your realms in `extension.json`.** The `realms` field names, per realm, exactly what the extension contributes:

```json
"realms": {
  "surface": { "applications": ["hello-world"], "sidebars": [], "daemon": true },
  "host":    { "mcpTools": ["bump"], "voice": false },
  "worker":  { "runtime": false, "workspaceProviders": [], "components": true }
}
```

Hello World fills all three: a `surface` bundle with one application and a daemon (no docked sidebars); a `host` bundle contributing the `bump` MCP tool (and no voice override); and a `worker` bundle that ships a component (the heartbeat/inspect halves) but backs no runtime or workspace provider. When `realms` is present the host treats it as the source of truth — a realm you don't declare is not loaded even if its directory exists, and a runtime registration your declaration doesn't cover is flagged as **drift** in the Extensions view. Set a realm's entry to `null` for a realm the extension has no bundle for. (Omitting `realms` entirely falls back to discovering contributions by which bundle directories exist, but declaring it is the recommended, self-documenting form.)

A few conventions this reference leans on, worth copying:

- **`localSettings` is storage, not a signaling channel — there is no `watch`.** It holds device-local UI state (column widths, expanded sets) read on mount and written on change. When two components must react to each other live, they do it over `bus.extension` events; durable state that must notify uses `store.watch`. A cross-realm hand-off (an action's `run()` in the daemon telling the open app to do something) writes the value to `localSettings` for read-at-mount **and** publishes a `bus.extension` event for the live case — the consumer reads at mount plus subscribes.
- **Contract-shaped literals set every field explicitly — a value or `null`, never by omission.** A definition (an `ActionField`, an `ActionDefinition`, a `PromptField`, an application's `requires`) fills each optional field with an explicit value or `null`, so the shape reads completely at the call site rather than relying on absent keys. A `SurfaceRequirement`'s per-axis arrays follow the same spirit: an empty `[]` means "unconstrained on this axis", never a missing key.
- **Store reads return a wrapper.** `store.getString(key)` / `getBytes(key)` resolve to `{ value }` (null when absent) and `store.list(prefix)` to `{ keys }`; the writers take a single options object (`store.putJson({ key, value })`). Read `(await store.getString(k)).value`, not the bare result.
