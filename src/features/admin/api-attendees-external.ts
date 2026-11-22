/** The external source part of POST /api/admin/attendees. A body can name an
 * external source and the attendee's id there. The create stores the link in
 * its own transaction. A retry with the same id answers with the attendee that
 * the first run stored. */

import { getAttendeeRaw } from "#db/attendees/queries.ts";
import { holderOfExternalIdOrNull } from "#db/external-sources/attendee-link.ts";
import {
  externalIdHeldRefusal,
  type LinkRefusal,
} from "#db/external-sources/queries.ts";
import type { ExternalSource } from "#db/external-sources/types.ts";
import { records } from "#db/record-table.ts";
import { requireValue } from "#shared/required-value.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { isPositiveSafeInteger } from "#shared/validation/number.ts";
import type { Attendee } from "#types";
import { requiredExternalId } from "./api-external-sources.ts";

/** The source a create body names, and the attendee's id there. */
export type ApiExternalLink = { externalId: string; source: ExternalSource };

/** The link a create body asks for: both fields, or neither. The source read
 *  pins to the primary, so a source created just before is always found. */
export const parseExternalLink = async (
  body: Record<string, unknown>,
): Promise<Result<ApiExternalLink | undefined>> => {
  const { external_id: rawId, external_source_id: sourceId } = body;
  if (rawId === undefined && sourceId === undefined) return okResult(undefined);
  if (rawId === undefined || sourceId === undefined) {
    return errorResult("external_source_id and external_id go together");
  }
  if (typeof sourceId !== "number" || !isPositiveSafeInteger(sourceId)) {
    return errorResult(
      "external_source_id must be a whole number of 1 or more",
    );
  }
  const externalId = requiredExternalId(body);
  if (!externalId.ok) return externalId;
  const source = await records.external_sources.findPrimary(sourceId);
  if (source === null) return errorResult("Unknown external source");
  return okResult({ externalId: externalId.value, source });
};

/** What a body's external id names in its source. It names nothing yet, or
 *  the attendee that an earlier create stored. It is refused when another kind
 *  of record holds the id. */
export type ExternalIdHolder =
  | { kind: "free" }
  | { attendee: Attendee; kind: "attendee" }
  | { kind: "refused"; refusal: LinkRefusal };

export const holderOfExternalLink = async ({
  externalId,
  source,
}: ApiExternalLink): Promise<ExternalIdHolder> => {
  const holder = await holderOfExternalIdOrNull(source.id, externalId);
  if (holder === null) return { kind: "free" };
  if (holder.linkType !== "attendee") {
    return {
      kind: "refused",
      refusal: externalIdHeldRefusal(holder.linkType, holder.linkId),
    };
  }
  return {
    attendee: requireValue(
      await getAttendeeRaw(holder.linkId),
      `Attendee ${holder.linkId} is missing`,
    ),
    kind: "attendee",
  };
};
