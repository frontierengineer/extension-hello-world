// ═══════════════════════════════════════════════════════════════════════════
//  ui/index.tsx — WHAT THE USER SEES
// ═══════════════════════════════════════════════════════════════════════════
//
//  TIER: ui (the browser-side half). The host bundles this with esbuild
//  (platform: browser, React pinned to this dir's own copy) and renders it in a
//  same-origin webview. It runs in a DIFFERENT process from server/index.ts, so
//  the two never share memory — the UI talks to its server ONLY over the bus
//  (`bus.extension.request` ⇄ the server's `respond`; `bus.extension.subscribe`
//  ⇐ the server's `publish`).
//
//  This file demonstrates, each clearly separated:
//    • views.register     — a top-level tab the extension owns end to end
//    • sidebar.register    — a section in the sidebar
//    • commands.register   — a command-palette action with a default keybinding
//    • modals.prompt       — a host-rendered modal to collect input
//    • prefs               — device-local UI state (NOT the durable Store)
//    • bus.extension.*     — calling its own server + rendering live events
//
//  The host hands each contribution a plain HTMLElement to render into; we use
//  React (createRoot) but the host doesn't care — it's framework-agnostic.
//  `../../types` is type-only (erased from the bundle); `react` resolves to the
//  copy this capability vendors (see ui/package.json).

import { useEffect, useState, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UiProvider, UiV1 } from '../../types';
import type { HelloState } from '../messages'; // our own root file (one level up); the host contract is '../../types' (two)

// We keep a handle to the live `ui` so React components reach the bus/services
// without prop-drilling. Set once in register().
let UI: UiV1;

// ── A tiny bus hook: live state from the server ────────────────────────────
// Fetch the current state once (request → the server's `state.get` responder),
// then stay live by subscribing to `state.changed` (the server publishes it on
// every mutation — a bump from here, the MCP tool, or a scheduler tick). This
// is the whole frontend↔backend loop in one hook.
function useHelloState(): HelloState | null {
  const [state, setState] = useState<HelloState | null>(null);

  useEffect(() => {
    let alive = true;
    UI.bus.extension
      .request<HelloState>('state.get')
      .then((s) => { if (alive) setState(s); })
      .catch(() => { /* responder briefly absent during a reload — the event below recovers us */ });

    const unsubscribe = UI.bus.extension.subscribe('state.changed', (s: HelloState) => setState(s));
    return () => { alive = false; unsubscribe(); };
  }, []);

  return state;
}

// ── The view body: the main tab content ────────────────────────────────────
// Reads live state, bumps the counter via the server, edits the note via a
// host modal, and renders the worker heartbeats the server fans out to us.
function HelloView() {
  const state = useHelloState();
  const [heartbeats, setHeartbeats] = useState<Array<{ machine: string; hostname: string; at: string }>>([]);

  // EVENTS: render the live worker→server→bus→UI fan-out. Each heartbeat began
  // on a daemon, went to the server, and the server re-published it to us.
  useEffect(() => {
    const unsubscribe = UI.bus.extension.subscribe('worker.heartbeat', (hb: any) => {
      setHeartbeats((prev) => [hb, ...prev].slice(0, 5));
    });
    return unsubscribe;
  }, []);

  const bump = useCallback(() => { void UI.bus.extension.request('state.bump', { by: 1 }); }, []);

  // MODAL: open a host-rendered prompt to collect the new note, then send it to
  // the server. The host owns the modal — we just await the field values.
  const editNote = useCallback(async () => {
    const result = await UI.modals.prompt({
      title: 'Edit note',
      description: 'Stored in the extension\'s durable Store on the server.',
      fields: [{ key: 'note', label: 'Note', type: 'string', default: state?.note ?? '' }],
      submitLabel: 'Save',
    });
    if (result) void UI.bus.extension.request('note.set', { note: result.note });
  }, [state]);

  return (
    <div style={{ padding: 16, lineHeight: 1.5, fontSize: 14 }}>
      <h2 style={{ marginTop: 0 }}>Hello World</h2>
      <p style={{ opacity: 0.8 }}>
        The reference extension. Everything on this page round-trips through the
        server over the bus — the UI keeps no durable state of its own.
      </p>

      <section style={{ margin: '16px 0' }}>
        <strong>Counter:</strong> {state ? state.count : '…'}{' '}
        <button className="btn-primary" onClick={bump} style={{ marginLeft: 8 }}>Bump</button>
      </section>

      <section style={{ margin: '16px 0' }}>
        <strong>Note:</strong> {state?.note ? state.note : <em style={{ opacity: 0.6 }}>(empty)</em>}{' '}
        <button onClick={() => { void editNote(); }} style={{ marginLeft: 8 }}>Edit…</button>
      </section>

      <WorkerInspector />

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
function WorkerInspector() {
  const [machine, setMachine] = useState('');
  const [result, setResult] = useState<string>('');

  // List connected machines via the host service so the user can pick one.
  const machines = UI.services.machines.list().filter((m) => m.connected);

  const inspect = useCallback(async () => {
    const target = machine || machines[0]?.id;
    if (!target) { setResult('no connected machine'); return; }
    setResult('inspecting…');
    try {
      const reply = await UI.bus.extension.request('worker.inspect', { machine: target });
      setResult(JSON.stringify(reply, null, 2));
    } catch (err: any) {
      setResult(`error: ${err?.message || err}`);
    }
  }, [machine, machines]);

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

// ── The sidebar body: a compact live counter + a Bump button ───────────────
function HelloSidebar() {
  const state = useHelloState();

  // PREFS: device-local UI state (a collapsed flag), NOT durable shared data.
  // Prefs live in this browser's localStorage, namespaced per extension, and
  // never sync or touch the server Store — perfect for view preferences.
  const [collapsed, setCollapsed] = useState<boolean>(() => UI.prefs.get('sidebar.collapsed', false) ?? false);
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      UI.prefs.set('sidebar.collapsed', next); // persisted on this device only
      return next;
    });
  }, []);

  return (
    <div style={{ padding: 12, fontSize: 13 }}>
      <button onClick={toggle} style={{ marginBottom: 8 }}>{collapsed ? 'Show' : 'Hide'} counter</button>
      {!collapsed && (
        <div>
          <div>Counter: <strong>{state ? state.count : '…'}</strong></div>
          <button
            className="btn-primary"
            style={{ marginTop: 8 }}
            onClick={() => { void UI.bus.extension.request('state.bump', { by: 1 }); }}
          >
            Bump
          </button>
        </div>
      )}
    </div>
  );
}

export function register(uiProvider: UiProvider): void {
  UI = uiProvider.version(1);

  // ── VIEW: a top-level tab the extension owns end to end ───────────────────
  // The view declares its `tabType` and the route prefix it answers to; the
  // host runs the routing (path → tabId, tabId → owner) from that declaration.
  // `mount` renders into a fresh host-owned element; `unmount` tears it down.
  const viewRoots = new Map<HTMLElement, Root>();
  UI.views.register({
    id: 'hello-world.main',
    tabType: 'hello-world',
    routes: [{ prefix: '/hello-world', exact: true }],
    mount: (_tabId, container, ctx) => {
      ctx.setLabel({ primary: 'Hello World' }); // push the tab's label to the host
      const root = createRoot(container);
      viewRoots.set(container, root);
      root.render(<HelloView />);
    },
    unmount: (container) => {
      viewRoots.get(container)?.unmount();
      viewRoots.delete(container);
    },
  });

  // ── SIDEBAR: a section in the sidebar ─────────────────────────────────────
  let sidebarRoot: Root | null = null;
  UI.sidebar.register({
    id: 'hello-world.sidebar',
    title: 'Hello World',
    mount: (container) => {
      sidebarRoot = createRoot(container);
      sidebarRoot.render(<HelloSidebar />);
    },
    unmount: () => { sidebarRoot?.unmount(); sidebarRoot = null; },
  });

  // ── COMMAND: a palette action with a suggested keybinding ─────────────────
  // Appears in the command palette (Cmd/Ctrl+Shift+P) and runs on the key. Here
  // it just navigates to the view's tab — `navigate` resolves the path against
  // the route the view declared above.
  UI.commands.register({
    id: 'hello-world.open',
    label: 'Open Hello World',
    category: 'Hello World',
    defaultKey: 'ctrl+alt+h',
    run: () => UI.navigate('/hello-world'),
  });

  // ── WELCOME TILE: a call-to-action on the empty welcome screen ────────────
  UI.welcome.contribute({
    id: 'hello-world.welcome',
    title: 'Hello World',
    description: 'Open the reference extension to see every Frontier capability in one place.',
    action: { label: 'Open', run: () => UI.navigate('/hello-world') },
  });
}
