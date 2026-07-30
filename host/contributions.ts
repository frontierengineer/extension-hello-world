// WHAT THIS HOST BUNDLE CONTRIBUTES — declared as data (see
// surface/contributions.ts for why every bundle declares itself this way).
//
//  An MCP tool's whole agent-facing surface is here: its name, title,
//  description and input schema. So the host can tell an agent what this
//  extension offers before the bundle is loaded — and still can if the bundle
//  fails to load, which is when the question matters most. index.ts registers the
//  HANDLER for the declared name; registering a name this file does not declare is
//  refused, so the agent can never see a tool with nothing behind it.
import type { HostContributions } from '../../types';

export const contributions = {
  daemons: [{ id: 'hello-world' }],
  mcpTools: [
    {
      name: 'bump',
      title: 'Bump the Hello World counter',
      description:
        'Increment the Hello World extension\'s shared counter. Use when asked to '
        + 'demonstrate that an agent can mutate an extension\'s persisted state via a tool. '
        + 'Pass `by` to add more than 1.',
      inputSchema: {
        type: 'object',
        properties: {
          by: { type: 'number', description: 'How much to add (default 1).' },
        },
      },
    },
  ],
} satisfies HostContributions;
