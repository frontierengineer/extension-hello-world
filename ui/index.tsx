import { createRoot, type Root } from 'react-dom/client';
import type { UiProvider } from '../../types';

let sidebarRoot: Root | null = null;

export function register(uiProvider: UiProvider): void {
  const ui = uiProvider.version(1);
  ui.sidebar.register({
    id: 'hello-frontier',
    title: 'Hello Frontier',
    mount: (container) => {
      sidebarRoot = createRoot(container);
      sidebarRoot.render(
        <div style={{ padding: 12, lineHeight: 1.5 }}>
          <strong>Hello from the marketplace!</strong>
          <p style={{ margin: '8px 0 0', fontSize: 12, opacity: 0.8 }}>
            This extension travelled: GitHub release → registry scan → hash-pinned
            index → verified install. Edit it live from the Extensions view — it's
            yours now.
          </p>
        </div>,
      );
    },
    unmount: () => { sidebarRoot?.unmount(); sidebarRoot = null; },
  });
}
