/**
 * What a link points at.
 *
 * The naming and the SQL come from the shared record-target vocabulary. This
 * module says which kinds a link can point at, which columns hold them, and the
 * statements that keep a record's links with it. A write checks the target
 * exists through the same vocabulary.
 */

import {
  defineRecordTarget,
  type RecordTarget,
  type RecordTargets,
} from "#db/record-target.ts";
import { sql, sqlName, type SqlStatement } from "#db/sql.ts";
import { EXTERNAL_LINK_KINDS, type ExternalLinkKind } from "./types.ts";

/** The table the links live in. Trusted constant, never input. */
const LINK_TABLE = "external_source_links";

/** The columns a link stores its record target in. */
const LINK_COLUMNS = { id: "link_id", kind: "link_type" };

/** One record an external id refers to: its kind, and which one of that kind. */
export type ExternalLinkTarget = RecordTarget<ExternalLinkKind>;

/** How to name and ask for the records external ids refer to. Each kind names
 *  its table, so a write can insist the record is really there. */
export const externalLinkTargets: RecordTargets<ExternalLinkKind> =
  defineRecordTarget({
    columns: LINK_COLUMNS,
    kinds: EXTERNAL_LINK_KINDS,
    tables: { attendee: "attendees", group: "groups", listing: "listings" },
  });

/** Delete the links that name one record. A record delete owns its links the
 *  way it owns its notes and image uses. */
export const clearExternalLinksStatement = (
  target: ExternalLinkTarget,
): SqlStatement => externalLinkTargets.deleteFrom(LINK_TABLE)(target);

/** Delete the links that name any of the records another query chooses. */
export const clearExternalLinksForIdsStatement = (
  kind: ExternalLinkKind,
  ids: SqlStatement,
): SqlStatement => externalLinkTargets.deleteChosenBy(LINK_TABLE)(kind, ids);

/** Move the links that name one record to another record, as a merge does. */
export const repointExternalLinksStatement = (
  kind: ExternalLinkKind,
  sourceId: number,
  targetId: number,
): SqlStatement =>
  sql`UPDATE ${sqlName(LINK_TABLE)} SET ${sqlName(LINK_COLUMNS.id)} = ${targetId} WHERE ${sqlName(LINK_COLUMNS.kind)} = ${kind} AND ${sqlName(LINK_COLUMNS.id)} = ${sourceId}`;
