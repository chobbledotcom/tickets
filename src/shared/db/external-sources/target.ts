/**
 * What a link points at.
 *
 * The naming and the SQL come from the shared record-target vocabulary. This
 * module only says which kinds a link can point at and which columns hold
 * them. A write checks the target exists through the same vocabulary.
 */

import {
  defineRecordTarget,
  type RecordTarget,
  type RecordTargets,
} from "#db/record-target.ts";
import { EXTERNAL_LINK_KINDS, type ExternalLinkKind } from "./types.ts";

/** One record an external id refers to: its kind, and which one of that kind. */
export type ExternalLinkTarget = RecordTarget<ExternalLinkKind>;

/** How to name and ask for the records external ids refer to. Each kind names
 *  its table, so a write can insist the record is really there. */
export const externalLinkTargets: RecordTargets<ExternalLinkKind> =
  defineRecordTarget({
    columns: { id: "link_id", kind: "link_type" },
    kinds: EXTERNAL_LINK_KINDS,
    tables: { attendee: "attendees", group: "groups", listing: "listings" },
  });
