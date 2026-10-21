// WHAT THIS SURFACE CONTRIBUTES — declared as data, not as code.
//
//  The host learns an extension's contributions by PARSING this file. Nothing in
//  it runs — not here, not on the host, not in a browser — which is what lets the
//  launcher draw this application's tile before any of the extension has loaded,
//  and lets the host answer "what does this extension offer?" with no screen open
//  at all.
//
//  That is why the file is restricted to static data: strings, numbers, booleans,
//  null, arrays and objects of them (and `+` between strings, so a long
//  description stays readable). A value the host would have to compute — a
//  variable, a function call, a template substitution — fails the build with a
//  message naming the file, the line, and the path to the offending value. Write
//  the finished value.
//
//  The other half of a contribution is its MOUNT, in index.tsx, registered under
//  the id declared here. The id is the join: this file says what the application
//  IS, the bundle says how it draws. Neither repeats the other, so they cannot
//  disagree.
import type { SurfaceContributions } from '../../types';

export const contributions = {
  // The ONE application. `requires` is a capability FLOOR: null means any
  // device may be offered it. A keyboard-only application would say
  // `{ physicalInputs: ['keyboard'], visualDensities: [], audioInputs: [], audioOutputs: [] }`
  // and would simply never appear on a phone — decided host-side, from this data,
  // with nothing loaded.
  applications: [
    {
      id: 'hello-world',
      title: 'Hello World',
      icon: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM1.5 8h13M8 1.5c1.8 1.7 2.8 4 2.8 6.5S9.8 12.8 8 14.5C6.2 12.8 5.2 10.5 5.2 8S6.2 3.2 8 1.5z',
      color: '#14b8a6',
      requires: null,
    },
  ],
  // The headless, always-on surface component. A daemon draws nothing and is
  // never chosen by a user, so an id is the whole declaration.
  daemons: [{ id: 'hello-world' }],
} satisfies SurfaceContributions;
