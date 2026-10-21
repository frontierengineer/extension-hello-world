// WHAT THIS WORKER BUNDLE CONTRIBUTES — declared as data (see
// surface/contributions.ts for why every bundle declares itself this way).
//
//  Ids only here, and that is deliberate. A runtime's label and options, and a
//  workspace definition's slot policy, are ANNOUNCED by the worker that loaded
//  the bundle: a fact discovered where the code runs is an announcement, not a
//  declaration. What this file declares is that a component EXISTS, which is what
//  the host needs in order to say so with no worker connected.
import type { WorkerContributions } from '../../types';

export const contributions = {
  daemons: [{ id: 'hello-world' }],
} satisfies WorkerContributions;
