# Hello World

A tiny demo extension that says hello and shows a live greeting inside Frontier.

Hello World is the friendly first thing to install when you want to see what a Frontier extension feels like. It owns its whole content surface — a single page that greets you, lets you set a short note, and shows a counter and live status that update on their own in real time — a gentle, no-stakes way to watch an extension come to life in Frontier. Nothing here touches your work; it's a self-contained little hello you can install, play with, and remove any time.

<!-- screenshot: the Hello World extension showing the greeting, the counter, the editable note, and live worker heartbeats -->

## Features

- A Hello World extension: one page that owns its content, with a greeting and a short note you can edit
- A counter and live status that refresh by themselves, so you can see the extension staying in sync
- A "Set note…" button backed by an **action** — the same thing the AI can do for you (just ask it to set the note), so you can watch a single operation work from both a button and the assistant
- A one-key command (in the command palette) to edit the note from anywhere
- Live worker heartbeats streamed from a connected machine, to show the full round-trip

## Install

Install Hello World from the **Extensions → Marketplace** tab in Frontier: find Hello World, click Install, and it's added to your workspace in one click (Frontier verifies the download before installing). No setup or configuration needed.

## How it's built (for authors)

Hello World is the reference extension — the smallest complete example to copy when starting your own. Read `surface/index.tsx` alongside these notes.

**`register()` is declaration only.** A surface bundle's `register()` names the components the extension contributes and nothing else — there is no logic in it. Hello World declares just two:

- **an application** (`surface.application.register`) — the one component that owns the whole content rect. Its `mount(host)` renders the view.
- **a daemon** (`surface.daemon.register`) — the headless, always-on component. Declare one only when the extension has always-on logic or registrations whose closures must outlive any visible surface. Everything a command, action, option source, uri handler, or status-bar item does belongs here, because the daemon keeps running while the extension is enabled — so a command invoked from the palette or an action called by the assistant reaches its `run()` with no app open. A purely visual extension declares no daemon at all.

**Logic lives in a mount context, never in `register()`.** Each component gets its capability from its own mount context, scoped to the component's lifetime:

- the daemon's `mount(ctx)` is where the background logic lives. `ctx` carries `services` and the registration surfaces (`ctx.commands`, `ctx.actions`, …). Hello World registers its command and its `hello-world.set_note` action here.
- the app's `mount(host)` renders the UI. `host` carries the same `services`, plus the container, the warm-keep `lifecycle`, and the host-chrome verbs.

**`services` is the substrate both contexts share.** It carries the `bus` (talk to the extension's own server), the durable `store`, the `workers`/`workspaces`/`sessions` fleet, and the surface helpers an extension reaches for constantly — `services.localSettings` (device-local UI state), `services.modals` (host-rendered prompt/confirm dialogs), `services.navigate`, the `sidebar`/`overlay` controls, and the `uri` helpers. Hello World talks to its server through `host.services.bus`, reads connected machines through `host.services.workers`, and opens its greeting dialog through `host.services.modals.prompt`.

A few conventions this reference leans on, worth copying:

- **`localSettings` is storage, not a signaling channel — there is no `watch`.** It holds device-local UI state (column widths, expanded sets) read on mount and written on change. When two components must react to each other live, they do it over `services.bus.extension` events; durable state that must notify uses `store.watch`. A cross-realm hand-off (an action's `run()` in the daemon telling the open app to do something) writes the value to `localSettings` for read-at-mount **and** publishes a `bus.extension` event for the live case — the consumer reads at mount plus subscribes.
- **Contract-shaped literals set every field explicitly — a value or `null`, never by omission.** A definition (an `ActionField`, a `CommandDefinition`, a `PromptField`, an application's `requires`) fills each optional field with an explicit value or `null`, so the shape reads completely at the call site rather than relying on absent keys.
- **Store reads return a wrapper.** `store.getString(key)` / `getBytes(key)` resolve to `{ value }` (null when absent) and `store.list(prefix)` to `{ keys }`; the writers take a single options object (`store.putJson({ key, value })`). Read `(await store.getString(k)).value`, not the bare result.
