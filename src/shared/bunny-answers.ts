// effects: pure
/** The shapes of Bunny API answers that more than one client reads. */

import * as v from "valibot";

/** An edge script: its default hostname and the pull zones linked to it. */
export const edgeScriptSchema = v.object({
  DefaultHostname: v.string(),
  LinkedPullZones: v.array(v.object({ Id: v.number() })),
});

/** One page of the database list: the databases, each shaped by `row`, and
 * whether more pages follow. A row names its own `id`, so a caller can brand
 * it. */
export const databasePageSchema = <Row extends v.ObjectEntries>(row: Row) =>
  v.object({
    databases: v.array(v.object(row)),
    page_info: v.object({ has_more_items: v.boolean() }),
  });
