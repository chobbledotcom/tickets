// effects: pure
/**
 * The logical metadata of a checkout session, read from what the provider
 * hands back. This is the boundary where the wire format becomes the shape
 * that the price signature and the order reader use.
 */

import * as v from "valibot";
import type {
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import { stringRecordSchema } from "#shared/validation/stored-json.ts";

/** The small fields that a Square checkout can carry packed into one `b`
 * entry. The webhook reads them back to the top level. */
const PACKED_KEYS = [
  "phone",
  "date",
  "day_count",
  "reservation_amount",
  "tax_policy",
  "balance_attendee_id",
  "site_token_index",
] as const;

/* jscpd:ignore-start -- static data, not code */
/** Every field of the logical metadata, by its name. */
const METADATA_FIELDS = [
  "_origin",
  "address",
  "allocations",
  "answer_ids",
  "balance_attendee_id",
  "bundle",
  "date",
  "day_count",
  "email",
  "items",
  "line_text_answer_ids",
  "listing",
  "modifiers",
  "name",
  "phone",
  "price_proof",
  "reservation_amount",
  "site_token_index",
  "special_instructions",
  "tax_policy",
  "text_answer_ids",
  "thank_you_url",
] as const satisfies readonly (keyof SessionMetadata)[];
/* jscpd:ignore-end */

type MetadataField = (typeof METADATA_FIELDS)[number];

/** The single metadata key the packed small fields are stored under. */
const PACKED_FIELD = "b";

/** The packed fields that a `b` entry holds. Only text values count. */
const collectPackedFields = (
  readValue: (key: (typeof PACKED_KEYS)[number]) => unknown,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const key of PACKED_KEYS) {
    const value = readValue(key);
    if (typeof value === "string") result[key] = value;
  }
  return result;
};

/**
 * Read the packed small fields back from a `b` JSON blob.
 *
 * A malformed blob, a non-object, or a field that is not text reads as no
 * packed data. The webhook then checks the price signature, which refuses
 * the order, so a corrupt `b` does not stop the handler first.
 */
const parsePackedFields = (raw: string): Partial<Record<string, string>> => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const source = parsed as Record<string, unknown>;
    return collectPackedFields((key) => source[key]);
  } catch {
    return {};
  }
};

/**
 * Validate that every metadata value is text and required fields are present.
 */
export const hasRequiredSessionMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): metadata is SessionMetadata => {
  if (!v.is(stringRecordSchema, metadata)) return false;
  return !!metadata.bundle || (!!metadata.name && !!metadata.items);
};

/**
 * Turn provider metadata into the one shape that the app and the price check
 * read. The small fields packed into `b` move back to the top level first. A
 * field that the checkout left out, or that a malformed `b` lost, reads as "".
 */
export const extractSessionMetadata = (
  metadata: Readonly<Partial<Record<string, string>>>,
): ValidatedPaymentSession["metadata"] => {
  const raw = metadata[PACKED_FIELD];
  const packed = raw ? parsePackedFields(raw) : {};
  const fields = {} as Record<MetadataField, string>;
  for (const key of METADATA_FIELDS) {
    fields[key] = packed[key] || metadata[key] || "";
  }
  return fields;
};
