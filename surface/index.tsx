// ═══════════════════════════════════════════════════════════════════════════
//  surface/index.tsx — WHAT THE USER SEES (an app)
// ═══════════════════════════════════════════════════════════════════════════
//
//  TIER: ui (the browser-side half). The host bundles this with esbuild
//  (platform: browser, React pinned to this dir's own copy) and renders it in a
//  same-origin webview. It runs in a DIFFERENT process from server/index.ts, so
//  the two never share memory — the UI talks to its server ONLY over the bus
//  (`bus.extension.request` ⇄ the server's `respond`; `bus.extension.subscribe`
//  ⇐ the server's `publish`).
//
//  In Frontier's shell, an extension owns the ENTIRE content rect. You register
//  exactly ONE app and render your whole UI into the container the host hands
//  you. There is no shared tab bar or shared sidebar — your app draws its own
//  layout (a single view here; richer apps compose @frontierengineer/ui's
//  ExtensionSidebar / ExtensionTabs / Split). This file is the canonical
//  "hello app": the smallest complete example an author copies to start a new one.
//
//  It demonstrates, each clearly separated:
//    • ui.application.register — the ONE app; mount(host) renders the whole view
//    • ui.commands.register    — a command-palette action with a default keybinding
//    • ui.actions.register     — a typed, agent-callable ACTION with a live picker
//                                field, rendered as a modal by the host and bound to
//                                an in-app <ActionButton> (one declaration → human
//                                modal + agent tool + scheduler; see register())
//    • <ActionButton>          — bind a button to an action: it runs the action AND
//                                drives the Info View from its docs, no glue code
//    • host.bus.extension.*  — calling its own server + rendering live events
//    • host.services           — reading the substrate (connected machines)
//    • host.lifecycle          — committing side effects only when activated
//    • ui.modals.prompt        — a host-rendered modal to collect ad-hoc input
//    • data-help / data-help-title — hover annotations that feed the Info View
//
//  `../../types` is type-only (erased from the bundle); `react` resolves to the
//  copy this capability vendors (see surface/package.json).

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
// @frontierengineer/ui — the host's shared UI kit (esbuild aliases it for every
// extension). <ActionButton actionId="…"> binds a button to a declared Action: the
// click RUNS the action (the host renders its input modal — pickers and all) and
// hovering it fills the bottom-left Info View from the action's title/description,
// so there is no separate onClick + help string to keep in sync. This is the
// canonical way to surface an operation in your UI — see register() below.
//
// Imported by SUBPATH (`/useAction`), not the package root: the kit's barrel
// re-exports heavy modules (FileBrowser/MonacoDiff pull in monaco), and esbuild
// won't tree-shake those out, so importing ActionButton from the root would bloat
// this minimal app by ~megabytes. The subpath pulls only the action machinery.
import { ActionButton } from '@frontierengineer/ui/useAction';
import type { UiProvider, UiV1, ExtensionHost } from '../../types';
import type { HelloState } from '../messages'; // our own root file (one level up); the host contract is '../../types' (two)

// The app's launcher glyph: an SVG path `d` drawn in a `0 0 16 16` viewBox and
// stroked in currentColor (the host tints it with the app's color). A globe —
// the canonical "hello, world" mark, and clean at icon size.
const HELLO_ICON = 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM1.5 8h13M8 1.5c1.8 1.7 2.8 4 2.8 6.5S9.8 12.8 8 14.5C6.2 12.8 5.2 10.5 5.2 8S6.2 3.2 8 1.5z';

// ── A tiny bus hook: live state from the server ────────────────────────────
// Fetch the current state once (request → the server's `state.get` responder),
// then stay live by subscribing to `state.changed` (the server publishes it on
// every mutation — a bump from here, the MCP tool, or a scheduler tick). This
// is the whole frontend↔backend loop in one hook.
function useHelloState(bus: UiV1['bus']): HelloState | null {
  const [state, setState] = useState<HelloState | null>(null);

  useEffect(() => {
    let alive = true;
    bus.extension
      .request<HelloState>('state.get')
      .then((s) => { if (alive) setState(s); })
      .catch(() => { /* responder briefly absent during a reload — the event below recovers us */ });

    const unsubscribe = bus.extension.subscribe('state.changed', (s: HelloState) => setState(s));
    return () => { alive = false; unsubscribe(); };
  }, [bus]);

  return state;
}

// ── The greeting SETTING, live ──────────────────────────────────────────────
// The same request→subscribe loop as state, but for the in-app SETTING. The
// greeting used to be a host-rendered Config field; now the extension owns its
// surface (the editor below) and the value round-trips through the server's
// greeting.get/set (which persist via config.set). Fetch once, then stay live on
// `greeting.changed` so an edit from any surface updates the tile immediately.
function useGreeting(bus: UiV1['bus']): string | null {
  const [greeting, setGreeting] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    bus.extension
      .request<{ greeting: string }>('greeting.get')
      .then((g) => { if (alive) setGreeting(g.greeting); })
      .catch(() => { /* responder briefly absent during a reload — the event below recovers us */ });

    const unsubscribe = bus.extension.subscribe('greeting.changed', (g: { greeting: string }) => setGreeting(g.greeting));
    return () => { alive = false; unsubscribe(); };
  }, [bus]);

  return greeting;
}

// ── The whole app: one full view, rendered into host.container ──────────────
// Reads live state, bumps the counter via the server, edits the note via a host
// modal, and renders the worker heartbeats the server fans out to us. The app
// owns its entire rect — here a single scrollable page.
function HelloApp({ ui, host }: { ui: UiV1; host: ExtensionHost }) {
  const state = useHelloState(host.bus);
  const greeting = useGreeting(host.bus);
  const [heartbeats, setHeartbeats] = useState<Array<{ machine: string; hostname: string; at: string }>>([]);

  // EVENTS: render the live worker→server→bus→UI fan-out. Each heartbeat began
  // on a daemon, went to the server, and the server re-published it to us.
  useEffect(() => {
    const unsubscribe = host.bus.extension.subscribe('worker.heartbeat', (hb: any) => {
      setHeartbeats((prev) => [hb, ...prev].slice(0, 5));
    });
    return unsubscribe;
  }, [host]);

  const bump = useCallback(() => { void host.bus.extension.request('state.bump', { by: 1 }); }, [host]);

  // Editing the NOTE is handled by the "hello-world.set_note" ACTION, surfaced via
  // the <ActionButton> in the Note section below — so the same operation is a human
  // modal, an agent tool (frontier.run_action), and a schedulable unit from ONE
  // declaration (see register()). Contrast it with the ad-hoc ui.modals.prompt used
  // for the greeting just below: reach for an action when an operation is worth
  // exposing (agent-callable, repeatable); reach for modals.prompt for a quick,
  // surface-local input that isn't a first-class operation.

  // EDIT THE GREETING SETTING in-app. This is where the setting lives now — no
  // host settings panel. Collect the new value with a host modal and send it to
  // the server's greeting.set (which persists via config.set); the tile updates
  // live off the greeting.changed event the server publishes.
  const editGreeting = useCallback(async () => {
    const result = await ui.modals.prompt({
      title: 'Edit greeting',
      description: 'A per-extension setting, saved on the server via config.set.',
      fields: [{ key: 'greeting', label: 'Greeting', type: 'string', default: greeting ?? '' }],
      submitLabel: 'Save',
    });
    if (result) void host.bus.extension.request('greeting.set', { greeting: result.greeting });
  }, [ui, host, greeting]);

  return (
    <div style={{ padding: 24, lineHeight: 1.5, fontSize: 14, maxWidth: 640 }}>
      <h2 style={{ marginTop: 0 }}>{greeting ?? 'Hello'} World</h2>
      <p style={{ opacity: 0.8 }}>
        The reference Frontier extension. The whole page lives in one app that
        owns its content rect, and everything on it round-trips through the server
        over the bus — the UI keeps no durable state of its own.
      </p>

      <section style={{ margin: '16px 0' }}>
        <strong>Greeting:</strong>{' '}
        {greeting === null ? <em style={{ opacity: 0.6 }}>…</em> : <span>{greeting}</span>}{' '}
        {/* A plain button still works — but it needs its OWN hover help. `data-help`
            (the body) + `data-help-title` (the heading) feed the bottom-left Info
            View through the host's hover bridge; an <ActionButton> derives the same
            pair from its action for free (see the Note section below). */}
        <button
          onClick={() => { void editGreeting(); }}
          style={{ marginLeft: 8 }}
          data-help="Edit the greeting shown at the top of this app. It's a per-extension setting saved on the server (config.set) — there is no host settings panel."
          data-help-title="Edit greeting"
        >Edit…</button>
        <div style={{ opacity: 0.6, fontSize: 12, marginTop: 2 }}>
          A setting the extension owns in-app — saved on the server via config.set, no host settings panel.
        </div>
      </section>

      <section style={{ margin: '16px 0' }}>
        <strong>Counter:</strong> {state ? state.count : '…'}{' '}
        <button
          className="btn-primary"
          onClick={bump}
          style={{ marginLeft: 8 }}
          data-help="Increment the counter by one. The server persists it to the extension's durable Store and re-renders this app from the state.changed event."
          data-help-title="Bump the counter"
        >Bump</button>
      </section>

      {/* NOTE — surfaced as an ACTION, not a hand-wired button. <ActionButton> binds
          to "hello-world.set_note" (declared in register() below): clicking it opens
          the host-rendered schema modal (the Note text field + a live Workspace
          picker), runs the action, and — because the action is declared once — the
          SAME operation is callable by an agent (frontier.run_action) and the
          scheduler. Hovering the button fills the Info View from the action's
          title/description with no separate help string. onResult fires only on a
          real success (a failure is surfaced in the modal, with the bad field
          highlighted), so there's nothing to handle here but the happy path. */}
      <section style={{ margin: '16px 0' }}>
        <strong>Note:</strong> {state?.note ? state.note : <em style={{ opacity: 0.6 }}>(empty)</em>}{' '}
        <ActionButton actionId="hello-world.set_note" style={{ marginLeft: 8 }}>Set note…</ActionButton>
      </section>

      <WorkerInspector host={host} />

      <section style={{ margin: '16px 0' }}>
        <strong>Live worker heartbeats</strong> (pushed daemon → server → bus → here):
        {heartbeats.length === 0 ? (
          <p style={{ opacity: 0.6, margin: '4px 0' }}>none yet — connect a machine</p>
        ) : (
          <ul style={{ margin: '4px 0' }}>
            {heartbeats.map((hb, i) => (
              <li key={i}>{hb.hostname} @ {new Date(hb.at).toLocaleTimeString()}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ── The worker round-trip, on demand ───────────────────────────────────────
// Calls the server's `worker.inspect`, which forwards to the worker component
// and awaits the correlated reply — surfacing data only code beside the
// machine's files could produce (hostname, cwd, a directory listing).
function WorkerInspector({ host }: { host: ExtensionHost }) {
  const [machine, setMachine] = useState('');
  const [result, setResult] = useState<string>('');

  // List connected machines via the host substrate so the user can pick one.
  const machines = host.machines.list().filter((m) => m.connected);

  const inspect = useCallback(async () => {
    const target = machine || machines[0]?.id;
    if (!target) { setResult('no connected machine'); return; }
    setResult('inspecting…');
    try {
      const reply = await host.bus.extension.request('worker.inspect', { machine: target });
      setResult(JSON.stringify(reply, null, 2));
    } catch (err: any) {
      setResult(`error: ${err?.message || err}`);
    }
  }, [host, machine, machines]);

  return (
    <section style={{ margin: '16px 0' }}>
      <strong>Worker inspect</strong> (server ⇄ worker channel, correlated reply):
      <div style={{ margin: '4px 0' }}>
        <select
          value={machine}
          onChange={(e) => setMachine(e.target.value)}
          data-help="Which connected machine to inspect. Leave on the first connected machine to use whichever is available."
          data-help-title="Target machine"
        >
          <option value="">{machines.length ? 'first connected machine' : 'no machines connected'}</option>
          {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>{' '}
        <button
          onClick={() => { void inspect(); }}
          data-help="Ask the chosen machine's worker to report its hostname, working directory and a short file listing — proving the server ⇄ worker round-trip with a correlated reply."
          data-help-title="Inspect the worker"
        >Inspect</button>
      </div>
      {result && <pre style={{ background: 'var(--bg-subtle, #0001)', padding: 8, overflow: 'auto' }}>{result}</pre>}
    </section>
  );
}

export function register(uiProvider: UiProvider): void {
  const ui = uiProvider.version(1);

  // ── COMMAND: a palette action with a suggested keybinding ─────────────────
  // Appears in the command palette (Cmd/Ctrl+Shift+P) and runs on the key.
  // Commands run in the CONTROLLER realm — a different webview from the app's
  // mount — so a command can't reach the app's React state or host.openExtension; it
  // acts through the substrate. Here it edits the note via a host modal and
  // sends it to the server over the bus; the open app re-renders from the
  // server's `state.changed` event. (Switching TO an app is the launcher's /
  // palette's job, not a command's.)
  ui.commands.register({
    id: 'hello-world.edit-note',
    label: 'Hello World: Edit note',
    category: 'Hello World',
    defaultKey: 'ctrl+alt+h',
    run: async () => {
      const result = await ui.modals.prompt({
        title: 'Edit note',
        description: 'Stored in the extension\'s durable Store on the server.',
        fields: [{ key: 'note', label: 'Note', type: 'string' }],
        submitLabel: 'Save',
      });
      if (result) void ui.bus.extension.request('note.set', { note: result.note });
    },
  });

  // ── ACTION: a typed, agent-callable operation the host renders a modal for ──
  //
  // THE pattern to copy when an operation is worth making first-class. ONE
  // ui.actions.register declaration yields THREE things with no extra code:
  //   1. a human modal — the host generates it from `input` (the <ActionButton> in
  //      the app above triggers it; so does the command palette and a host CTA),
  //   2. an agent tool — frontier.run_action "hello-world.set_note" runs the SAME
  //      run() with the SAME input shape (description is written FOR the model),
  //   3. a schedulable unit — frontier.schedule_action can fire it on a trigger.
  //
  // `input` mixes a plain field with a LIVE PICKER: `note` is a text input, and
  // `workspace` is a real machine→workspace chooser the host populates from the
  // live fleet — the user never types a raw workspace id, yet the field resolves to
  // one (so an agent passes a workspaceId string directly). That picker is the
  // whole reason an action modal can replace a bespoke cascade modal.
  //
  // run() executes in THIS controller realm (it reaches the server over the bus),
  // NEVER on the host. It returns an explicit ActionOutcome: a precondition
  // violation is `{ ok:false, field, error }` (the host modal highlights that field
  // inline and keeps itself open — try submitting an empty note), and success
  // returns a value the <ActionButton>'s onResult / an agent can read.
  ui.actions.register({
    id: 'hello-world.set_note',
    title: 'Set the note',
    description:
      'Set the Hello World note — the free-text line the app stores in its durable Store. ' +
      'Pass `note` (the text). Optionally pass a `workspace` (a workspaceId; the UI shows a ' +
      'picker) to tag which workspace the note is about — it is appended to the saved text. ' +
      'Returns the saved note. Same operation as the in-app "Set note…" button.',
    input: {
      fields: [
        { key: 'note', type: 'string', label: 'Note', required: true, placeholder: 'Write a note…', description: 'The text to store.' },
        // The LIVE picker: a machine→workspace cascade the host renders and fills
        // from the connected fleet. Optional here — omit it and the note is saved
        // as-is. Resolves to a workspaceId string (what an agent would pass).
        { key: 'workspace', type: 'workspace', label: 'About workspace', description: 'Optional — tag the note with a workspace (resolves to its id).' },
      ],
    },
    async run(_ctx, input) {
      const args = (input ?? {}) as { note?: string; workspace?: string };
      const note = String(args.note ?? '').trim();
      // Precondition → an explicit failure naming the offending field, so the host
      // modal points at it (and an agent gets a stable code) instead of throwing.
      if (!note) return { ok: false, code: 'empty_note', field: 'note', error: 'A note is required.' };
      // The picker resolved to a workspace id (or nothing); fold it into the text so
      // the demo SHOWS the id the picker produced.
      const workspaceId = args.workspace ? String(args.workspace) : '';
      const text = workspaceId ? `${note} [re: ${workspaceId}]` : note;
      await ui.bus.extension.request('note.set', { note: text });
      return { note: text };
    },
  });

  // ── THE APP: one registration that owns the whole content rect ────────────
  // metadata ({id,title,icon,color}) is declared to the host immediately so the
  // launcher can draw the icon before the app is ever opened. mount(host) runs
  // ONCE, the first time the host warms this app's webview; it renders the whole
  // UI into host.container and returns an optional teardown the host runs if the
  // user quits the app from the launcher.
  let root: ReturnType<typeof createRoot> | null = null;
  ui.application.register({
    id: 'hello-world',
    title: 'Hello World',
    icon: HELLO_ICON,
    color: '#14b8a6',
    mount(host: ExtensionHost) {
      root = createRoot(host.container);
      root.render(<HelloApp ui={ui} host={host} />);
      return () => { root?.unmount(); root = null; };
    },
  });
}
