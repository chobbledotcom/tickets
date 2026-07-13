/** Props for a component whose only input is the children it wraps. */

import type { Child } from "#jsx/jsx-runtime.ts";

/** A component that simply wraps its `children`. */
export type ChildProps = { children: Child };
