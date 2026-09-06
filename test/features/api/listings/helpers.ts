import { makeParent } from "#test-utils/parents.ts";
import { enablePublicApi } from "#test-utils/settings.ts";

/** Make a public daily parent with one child that serves Mondays. */
export const publicDailyParentWithMondayChild = async (): ReturnType<
  typeof makeParent
> => {
  await enablePublicApi();
  return makeParent({
    children: [{ bookableDays: ["Monday"], daily: true }],
    parent: { daily: true },
  });
};
