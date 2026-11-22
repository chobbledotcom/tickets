/**
 * The link between a new attendee and its id at an external source.
 *
 * The attendee create writes this link in its own transaction. A retry with the
 * same external id finds the attendee that the first run stored.
 */

import type { TxScope } from "#db/client.ts";
import { encoded } from "#db/codecs/decode.ts";
import { executeChangedRowIn } from "#db/guarded-writes.ts";
import { readOneRow } from "#db/read.ts";
import { valued } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { insertInto } from "#db/write.ts";
import { namedError } from "#shared/named-error.ts";
import { nowIso } from "#shared/now.ts";
import { externalLinkIndex } from "./queries.ts";

/** Another create stored an attendee under this external id first. */
export class ExternalIdTaken extends namedError("ExternalIdTaken") {}

/** The attendee that one source already links to one external id, or null when
 *  no attendee holds that id. Null is the normal answer for a first create. */
export const attendeeIdForExternalIdOrNull = async (
  sourceId: number,
  externalId: string,
): Promise<number | null> => {
  const link = await readOneRow(
    from(tables.external_source_links)
      .where({
        externalIdIndex: await externalLinkIndex(sourceId, externalId),
        linkType: "attendee",
        sourceId,
      })
      .limit(1)
      .pick("linkId"),
  );
  return link === null ? null : link.linkId;
};

/** Link a new attendee to its external id in the create transaction. One
 *  statement stores the link only while no attendee holds the id, so two
 *  creates that race cannot both succeed. The loser throws and its whole
 *  create rolls back. */
export const linkNewAttendee = async (
  tx: TxScope,
  sourceId: number,
  externalId: string,
  attendeeId: number,
): Promise<void> => {
  const index = await externalLinkIndex(sourceId, externalId);
  const statement = insertInto(
    tables.external_source_links,
    await encoded(tables.external_source_links, {
      created: nowIso(),
      externalId,
      externalIdIndex: index,
      linkId: attendeeId,
      linkType: "attendee",
      sourceId,
    }),
    {
      when: valued(sql`NOT EXISTS (
        SELECT 1 FROM external_source_links AS takenLink
         WHERE takenLink.source_id = ${sourceId}
           AND takenLink.external_id_index = ${index}
           AND takenLink.link_type = ${"attendee"}
      )`),
    },
  );
  if (!(await executeChangedRowIn(tx, statement))) throw new ExternalIdTaken();
};
