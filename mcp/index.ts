// ═══════════════════════════════════════════════════════════════════════════
//  mcp/index.ts — A TOOL THE AGENT CAN CALL
// ═══════════════════════════════════════════════════════════════════════════
//
//  TIER: mcp (its own host-side capability — like server/, it runs in the host
//  process, but it contributes TOOLS to AI sessions rather than answering the
//  UI). A registered tool is visible to EVERY agent turn across all sessions
//  and all applications; the host namespaces it by application id, so the agent
//  sees this one as `hello-world.bump`.
//
//  WHY a separate file from server/index.ts: a capability is a separate module
//  instance — it shares NO memory with server/. The two coordinate through a
//  service they both have: the Store. So this tool writes the SAME state blob
//  the server reads, and the next UI read (or a server scheduler tick) reflects
//  it. (If a capability needs to share live in-memory state, fold its logic
//  into ONE capability — spaces, for instance, keeps its host logic all in mcp/.
//  Here the demo is clearer split out, and the Store is the honest seam.)
//
//  The tool handler runs on the HOST (not the worker), so it has the application's
//  Store, config, etc. — see `mcp.services`.

import type { McpProvider, ToolResult, ToolContext, Store } from '../../types';
import type { HelloState } from '../messages';

// Mirror the server's key + defaults — both capabilities read/write this one
// blob (the Store is the shared seam between them).
const STATE_KEY = 'state/hello';

function freshState(): HelloState {
  return { count: 0, note: '', updatedAt: new Date().toISOString() };
}

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] };
}

export function register(mcpProvider: McpProvider): void {
  const mcp = mcpProvider.version(1);
  const store: Store = mcp.services.store;

  async function readState(): Promise<HelloState> {
    const raw = await store.get(STATE_KEY);
    if (raw === null) return freshState();
    try {
      return JSON.parse(raw) as HelloState;
    } catch {
      return freshState();
    }
  }

  // Register one tool. The `description` is what the model reads to decide when
  // to call it — write it for the agent. `inputSchema` is JSON Schema; the host
  // converts it to what the MCP SDK wants. `ctx.sessionId` identifies the agent
  // run, so a handler could scope per-session work (unused here).
  mcp.registerTool({
    name: 'bump',
    title: 'Bump the Hello World counter',
    description:
      'Increment the Hello World application\'s shared counter. Use when asked to ' +
      'demonstrate that an agent can mutate an application\'s persisted state via a tool. ' +
      'Pass `by` to add more than 1.',
    inputSchema: {
      type: 'object',
      properties: {
        by: { type: 'number', description: 'How much to add (default 1).' },
      },
    },
    handler: async (args: { by?: number }, _ctx: ToolContext): Promise<ToolResult> => {
      const state = await readState();
      state.count += typeof args?.by === 'number' ? args.by : 1;
      state.updatedAt = new Date().toISOString();
      await store.put(STATE_KEY, JSON.stringify(state));
      // NOTE: this capability can persist, but it can't publish on the server's
      // private bus channel (different capability instance). The UI stays live
      // anyway because the server's Store-backed reads pick this change up; a
      // production application that needs an instant push would keep the writer in
      // one capability. Kept simple here to show the Store-as-seam pattern.
      return text(`Counter is now ${state.count}.`);
    },
  });
}
