// ═══════════════════════════════════════════════════════════════════════════
//  ui/index.tsx — WHAT THE USER SEES (an app)
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
//    • host.bus.extension.*  — calling its own server + rendering live events
//    • host.services           — reading the substrate (connected machines)
//    • host.lifecycle          — committing side effects only when activated
//    • ui.modals.prompt        — a host-rendered modal to collect input
//
//  `../../types` is type-only (erased from the bundle); `react` resolves to the
//  copy this capability vendors (see ui/package.json).

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
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

// ── The whole app: one full view, rendered into host.container ──────────────
// Reads live state, bumps the counter via the server, edits the note via a host
// modal, and renders the worker heartbeats the server fans out to us. The app
// owns its entire rect — here a single scrollable page.
function HelloApp({ ui, host }: { ui: UiV1; host: ExtensionHost }) {
  const state = useHelloState(host.bus);
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

  // MODAL: open a host-rendered prompt to collect the new note, then send it to
  // the server. The host owns the modal — we just await the field values.
  const editNote = useCallback(async () => {
    const result = await ui.modals.prompt({
      title: 'Edit note',
      description: 'Stored in the extension\'s durable Store on the server.',
      fields: [{ key: 'note', label: 'Note', type: 'string', default: state?.note ?? '' }],
      submitLabel: 'Save',
    });
    if (result) void host.bus.extension.request('note.set', { note: result.note });
  }, [ui, host, state]);

  return (
    <div style={{ padding: 24, lineHeight: 1.5, fontSize: 14, maxWidth: 640 }}>
      <h2 style={{ marginTop: 0 }}>Hello World</h2>
      <p style={{ opacity: 0.8 }}>
        The reference Frontier extension. The whole page lives in one app that
        owns its content rect, and everything on it round-trips through the server
        over the bus — the UI keeps no durable state of its own.
      </p>

      <section style={{ margin: '16px 0' }}>
        <strong>Counter:</strong> {state ? state.count : '…'}{' '}
        <button className="btn-primary" onClick={bump} style={{ marginLeft: 8 }}>Bump</button>
      </section>

      <section style={{ margin: '16px 0' }}>
        <strong>Note:</strong> {state?.note ? state.note : <em style={{ opacity: 0.6 }}>(empty)</em>}{' '}
        <button onClick={() => { void editNote(); }} style={{ marginLeft: 8 }}>Edit…</button>
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
        <select value={machine} onChange={(e) => setMachine(e.target.value)}>
          <option value="">{machines.length ? 'first connected machine' : 'no machines connected'}</option>
          {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>{' '}
        <button onClick={() => { void inspect(); }}>Inspect</button>
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
