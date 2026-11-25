/** What the scan API answers a door. The scan route writes these bodies in
 * `scan-answer.ts` and `scan-reply.ts`. The camera scan, the manual
 * check-in, and the offline queue parse each answer once with this schema,
 * then read its fields with no guess. The schema names only the fields a
 * page reads. */

import * as v from "valibot";
import { integerAtLeast } from "#shared/validation/number.ts";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

/** One known answer: its status, and the fields a page reads for it. */
const answerOf = <Status extends string, Entries extends v.ObjectEntries>(
  status: Status,
  entries: Entries,
) => v.object({ ...entries, status: v.literal(status) });

/** What a queued delivery that named more people than its landing admitted
 * reports: the people it named, admitted, and the places the booking
 * holds. */
const OverAdmissionSchema = v.optional(
  v.object({
    admitted: integerAtLeast(0),
    bought: integerAtLeast(0),
    named: integerAtLeast(0),
  }),
);

/** The fields of an answer that counts places. They name the person, the
 * places this answer covers, the places the lines hold, and the listings. */
const counted = {
  listingName: v.string(),
  name: v.string(),
  overAdmission: OverAdmissionSchema,
  quantity: integerAtLeast(0),
  total: integerAtLeast(0),
};

const KnownAnswerSchema = v.variant("status", [
  answerOf("checked_in", { ...counted, remaining: integerAtLeast(0) }),
  answerOf("already_checked_in", counted),
  answerOf("verify_id", { name: v.string() }),
  answerOf("select_quantity", { max: integerAtLeast(1), name: v.string() }),
  answerOf("wrong_listing", { listingName: v.string(), name: v.string() }),
  answerOf("refunded", { name: v.string() }),
  answerOf("not_found", {}),
]);

/** Every other body: a refusal, which the API writes as `{ error }`, or a
 * status this page has no words for. It parses as the status "other", so
 * every answer is keyed by its status. */
const OtherAnswerSchema = v.pipe(
  v.object({ error: v.optional(NonEmptyTextSchema) }),
  v.transform((other) => ({ ...other, status: "other" as const })),
);

/** One scan answer, keyed by its status. */
export const ScanAnswerSchema = v.union([KnownAnswerSchema, OtherAnswerSchema]);

export type ScanAnswer = v.InferOutput<typeof ScanAnswerSchema>;

/** The answer of one status. */
export type AnswerOf<Status extends ScanAnswer["status"]> = Extract<
  ScanAnswer,
  { status: Status }
>;
