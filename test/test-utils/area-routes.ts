import { expect } from "@std/expect";

/** A route module as the area loader reads it. */
type AreaModule = { adminHandlers: Record<string, unknown> };

/** Assert the exact routes one admin area module binds, in sorted order.
 *  The caller passes a dynamic import and this reads the handlers by member
 *  access, the way the area loader does: a static import of `adminHandlers`
 *  would make the test-only-export scan count every such export as
 *  test-only. */
export const expectAreaRoutes = async (
  load: () => Promise<AreaModule>,
  routes: string[],
): Promise<void> => {
  const module = await load();
  expect(Object.keys(module.adminHandlers).toSorted()).toEqual(routes);
};
