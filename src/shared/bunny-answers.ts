// effects: pure
/** The shapes of Bunny API answers that more than one client reads. */

import * as v from "valibot";

/** An edge script: its default hostname and the pull zones linked to it. */
export const edgeScriptSchema = v.object({
  DefaultHostname: v.string(),
  LinkedPullZones: v.array(v.object({ Id: v.number() })),
});

/** One page of the database list: the databases, each with its id and the
 * fields the caller reads, and whether more pages follow. */
export const databasePageSchema = <Fields extends v.ObjectEntries>(
  fields: Fields,
) =>
  v.object({
    databases: v.array(v.object({ id: v.string(), ...fields })),
    page_info: v.object({ has_more_items: v.boolean() }),
  });
