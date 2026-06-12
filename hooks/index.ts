// ═══════════════════════════════════════════════════════════════════════════
//  hooks/index.ts — RUN AT A MOMENT IN A CORE FLOW
// ═══════════════════════════════════════════════════════════════════════════
//
//  TIER: hooks (its own host-side capability). The host fires NAMED hooks at
//  well-defined moments in its flows (e.g. just before / after a session
//  dispatch). An extension registers a handler to run arbitrary work at that
//  moment. The host attaches NO meaning to what a handler does — a hook is just
//  a place to plug in. This is what keeps the core ignorant of everything
//  extensions build (VCS, telemetry, policy): it knows it has a "before a turn"
//  moment and nothing more.
//
//  Two dials you DECLARE per handler, because only you know your intent:
//    • blocking — does the flow WAIT for you before continuing? `false` here:
//      this is advisory logging with no ordering constraint, so it must not
//      make a dispatch wait.
//    • timeoutMs — your expected worst case; exceeding it (if blocking) means
//      "stuck", and the host proceeds without you.
//
//  A handler is told WHAT is happening and WHERE (the ctx) — never handed a
//  capability. To ACT it uses the `services` it captured at registration
//  (machines.exec on the worker, store to persist, …). Throwing is caught and
//  logged; a hook can't break or veto the flow.

import type { HooksProvider, SessionDispatchHookContext } from '../../types';
import { HOOKS } from '../../types'; // runtime constant — the canonical hook name

export function register(hooksProvider: HooksProvider): void {
  const hooks = hooksProvider.version(1);

  // Observe every session dispatch, fire-and-forget. A real extension might
  // record telemetry, post a notification, or (blocking) position the working
  // directory. We just log the dispatch's coordinates to show the wiring.
  hooks.register({
    hook: HOOKS.SESSION_PRE_DISPATCH_V1,
    blocking: false,      // advisory — never make the dispatch wait on us
    timeoutMs: 5_000,
    handler: async (ctx: SessionDispatchHookContext) => {
      console.log(
        `[hello-world] a turn is about to run — session ${ctx.sessionId} on ` +
        `machine ${ctx.machine} in ${ctx.directory}`,
      );
    },
  });
}
