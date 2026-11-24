/** What the scan API answers a manual check-in. The scan route writes these
 * bodies in `scan-answer.ts` and `scan-reply.ts`. The page parses each
 * answer once with this schema, then reads its fields with no guess. The
 * schema names only the fields the page reads. */

import * as v from "valibot";
import { integerAtLeast } from "#shared/validation/number.ts";

/** One known answer: its status, and the fields the page reads for it. */
const answerOf = <Status extends string, Entries extends v.ObjectEntries>(
  status: Status,
  entries: Entries,
) => v.object({ ...entries, status: v.literal(status) });

/** The fields of an answer that counts places. They name the person, the
 * places this answer covers, the places the lines hold, and the listings. */
const counted = {
  listingName: v.string(),
  name: v.string(),
  quantity: integerAtLeast(0),
  total: integerAtLeast(0),
};

const KnownAnswerSchema = v.variant("status", [
  answerOf("checked_in", { ...counted, remaining: integerAtLeast(0) }),
  answerOf("already_checked_in", counted),
  answerOf("verify_id", { name: v.string() }),
  answerOf("select_quantity", { max: integerAtLeast(1), name: v.string() }),
  answerOf("refunded", { name: v.string() }),
  answerOf("not_found", {}),
]);

/** Every other body: a refusal such as `{ error }`, or a status this page
 * has no words for. It parses as the status "other", so every answer is
 * keyed by its status. The page shows its error or message text. */
const OtherAnswerSchema = v.pipe(
  v.object({
    error: v.optional(v.string()),
    message: v.optional(v.string()),
  }),
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
