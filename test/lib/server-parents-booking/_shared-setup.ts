import { makeParent } from "#test-utils/parents.ts";
import { enablePublicApi } from "#test-utils/settings.ts";

/** Turn on the public API, then make a daily parent whose only (daily) child is
 * bookable on Mondays only. This is the shared setup for the child-date-union
 * tests: the parent's own calendar is wider than any single date the child can
 * serve, so both the availability and the detail endpoints must honour the
 * intersection. */
export const publicDailyParentWithMondayChild = async (): ReturnType<
  typeof makeParent
> => {
  await enablePublicApi();
  return makeParent({
    children: [{ bookableDays: ["Monday"], daily: true }],
    parent: { daily: true },
  });
};
