import { decrypt, encrypt } from "#crypto/encryption.ts";
import { decryptWithOwnerKey } from "#crypto/keys.ts";
import type { EnvKeyEncrypted, OwnerKeyEncrypted } from "#crypto/sealed.ts";
import {
  inPlaceholders,
  queryAllPrimary,
  type SqlStatement,
  withTransaction,
} from "#db/client.ts";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import type { QuestionListingMap } from "#db/questions/queries.ts";
import { getOrCreateStringIds } from "#db/questions/strings.ts";
import { requiredMapValue, unique } from "#fp";
import {
  type AnswerLineSource,
  type FreeTextAnswers,
  loadOrderAnswerLines,
  type OrderAnswerLines,
} from "#shared/email/answers.ts";
import type { EmailEntry } from "#shared/email.ts";

export type SubmittedAnswer = {
  questionId: number;
  question: string;
  text: string;
  kind: "choice" | "free_text";
};

/** A booked line keeps its identity even when it has no answered questions. */
export type SubmittedAnswers = readonly {
  listingId: number;
  answers: readonly SubmittedAnswer[];
}[];

type SubmittedInput = {
  activeQuestions: readonly QuestionWithAnswers[];
  answerIds: readonly number[];
  textAnswers: readonly { questionId: number; text: string }[];
};

/** The buyer's typed free-text answers, keyed by the question they answer. */
export const textsByQuestionId = (
  texts: readonly { questionId: number; text: string }[],
): Map<number, string> =>
  new Map(texts.map(({ questionId, text }) => [questionId, text]));

/** Pair each choice question with the answer id the buyer picked, in the
 * order the checkout form submits them. */
const chosenAnswerByQuestion = (info: SubmittedInput): Map<number, number> => {
  const chosen = new Map<number, number>();
  let answerIndex = 0;
  for (const question of info.activeQuestions) {
    if (
      question.display_type === "free_text" ||
      !question.answers.some((a) => a.active)
    ) {
      continue;
    }
    chosen.set(question.id, info.answerIds[answerIndex++]!);
  }
  if (answerIndex !== info.answerIds.length) {
    throw new Error("Invalid checkout answer selection");
  }
  return chosen;
};

/** Whether a question asks on this booked line: every listing for an
 * assign-all question, only its assigned ones otherwise. */
const asksOnListing = (
  question: QuestionWithAnswers,
  listingId: number,
  assignments: QuestionListingMap,
): boolean =>
  question.assign_all ||
  (assignments.get(question.id) ?? []).includes(listingId);

/** The answer text this buyer gave for one question: the typed text for a
 * free-text question, the picked option's words for a choice. */
const submittedTextFor = (
  question: QuestionWithAnswers,
  chosen: Map<number, number>,
  typed: Map<number, string>,
): string | undefined =>
  question.display_type === "free_text"
    ? typed.get(question.id)
    : question.answers.find((answer) => answer.id === chosen.get(question.id))
        ?.text;

/** Capture server-validated wording, never labels supplied by the browser. */
export const submittedAnswersForCheckout = (
  items: readonly { listingId: number }[],
  info: SubmittedInput,
  assignments: QuestionListingMap,
): SubmittedAnswers => {
  const chosen = chosenAnswerByQuestion(info);
  const typed = textsByQuestionId(info.textAnswers);
  return items.map(({ listingId }) => ({
    answers: info.activeQuestions.flatMap((question): SubmittedAnswer[] => {
      if (!asksOnListing(question, listingId, assignments)) return [];
      const text = submittedTextFor(question, chosen, typed);
      return text === undefined
        ? []
        : [
            {
              kind:
                question.display_type === "free_text" ? "free_text" : "choice",
              question: question.text,
              questionId: question.id,
              text,
            },
          ];
    }),
    listingId,
  }));
};

type ReceiptRow = {
  attendee_id: number;
  listing_id: number;
  ordinal: number | null;
  question_id: number | null;
  kind: "choice" | "free_text" | null;
  question: string | null;
  choice_text: string | null;
  string_id: number | null;
  encrypted_text: OwnerKeyEncrypted | null;
};

const receiptRows = (entries: readonly EmailEntry[]): Promise<ReceiptRow[]> => {
  const ids = unique(entries.map((entry) => entry.attendee.id));
  return ids.length === 0
    ? Promise.resolve([])
    : queryAllPrimary<ReceiptRow>({
        args: ids,
        sql: `SELECT receipt.attendee_id, receipt.listing_id, line.ordinal, line.question_id,
      line.kind, line.question, line.choice_text, line.string_id, string.encrypted_text
      FROM submitted_answer_receipts AS receipt
      LEFT JOIN submitted_answer_receipt_lines AS line ON line.attendee_id = receipt.attendee_id
      LEFT JOIN strings AS string ON string.id = line.string_id
      WHERE receipt.attendee_id IN (${inPlaceholders(ids)})
      ORDER BY receipt.attendee_id, line.ordinal`,
      });
};

/** Save each booking row once. A replay never rewrites its original wording. */
export const saveSubmittedAnswerReceipts = async (
  entries: readonly EmailEntry[],
  snapshot: SubmittedAnswers,
): Promise<void> => {
  if (entries.length === 0) return;
  const byListing = new Map(
    snapshot.map((line) => [line.listingId, line.answers]),
  );
  const texts = unique(
    snapshot
      .flatMap((line) => line.answers)
      .filter((answer) => answer.kind === "free_text")
      .map((answer) => answer.text),
  );
  const stringIds = await getOrCreateStringIds(texts);
  const prepared = await Promise.all(
    entries.map(async (entry) => {
      const line = requiredMapValue(
        byListing,
        entry.listing.id,
        `Missing checkout snapshot for listing ${entry.listing.id}`,
      );
      return {
        attendeeId: entry.attendee.id,
        lines: await Promise.all(
          line.map(async (answer, ordinal) => ({
            attendeeId: entry.attendee.id,
            choiceText:
              answer.kind === "choice" ? await encrypt(answer.text) : null,
            kind: answer.kind,
            ordinal,
            question: await encrypt(answer.question),
            questionId: answer.questionId,
            stringId:
              answer.kind === "free_text"
                ? requiredMapValue(
                    stringIds,
                    answer.text,
                    "Missing sealed submitted text",
                  )
                : null,
          })),
        ),
        listingId: entry.listing.id,
      };
    }),
  );
  await withTransaction(async (tx) => {
    for (const entry of prepared) {
      const existing = await tx.execute({
        args: [entry.attendeeId],
        sql: "SELECT listing_id FROM submitted_answer_receipts WHERE attendee_id = ?",
      });
      if (existing.rows.length > 0) {
        if (existing.rows[0]!.listing_id !== entry.listingId) {
          throw new Error("Receipt belongs to another listing");
        }
        continue;
      }
      await tx.execute({
        args: [entry.attendeeId, entry.listingId],
        sql: "INSERT INTO submitted_answer_receipts (attendee_id, listing_id) VALUES (?, ?)",
      });
      if (entry.lines.length === 0) continue;
      await tx.batch(
        entry.lines.map(
          (answer): SqlStatement => ({
            args: [
              answer.attendeeId,
              answer.ordinal,
              answer.questionId,
              answer.kind,
              answer.question,
              answer.choiceText,
              answer.stringId,
            ],
            sql: `INSERT INTO submitted_answer_receipt_lines
          (attendee_id, ordinal, question_id, kind, question, choice_text, string_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          }),
        ),
      );
    }
  });
};

export const loadSubmittedAnswerLines: AnswerLineSource = async (
  entries,
  freeTexts = new Map(),
) => {
  const rows = await receiptRows(entries);
  const recorded = new Set(rows.map((row) => row.attendee_id));
  const legacy = entries.filter((entry) => !recorded.has(entry.attendee.id));
  const result = legacy.length
    ? await loadOrderAnswerLines(legacy, freeTexts)
    : (new Map() as OrderAnswerLines);
  for (const entry of entries) {
    if (!recorded.has(entry.attendee.id)) continue;
    const matching = rows.filter(
      (row) => row.attendee_id === entry.attendee.id,
    );
    if (matching.some((row) => row.listing_id !== entry.listing.id)) {
      throw new Error("Receipt belongs to another listing");
    }
    const lines = await Promise.all(
      matching
        .filter((row) => row.ordinal !== null)
        .map(async (row) => {
          const question = await decrypt(row.question as EnvKeyEncrypted);
          if (row.kind === "choice") {
            return {
              question,
              text: await decrypt(row.choice_text as EnvKeyEncrypted),
            };
          }
          if (row.string_id === null || row.encrypted_text === null) {
            throw new Error("Missing submitted text receipt");
          }
          const text = freeTexts.get(row.question_id!);
          if (text === undefined) {
            throw new Error(
              "Submitted text needs an owner key or checkout snapshot",
            );
          }
          return { question, text };
        }),
    );
    const byListing = result.get(entry.attendee.id) ?? new Map();
    byListing.set(entry.listing.id, lines);
    result.set(entry.attendee.id, byListing);
  }
  return result;
};

/** The authenticated owner's key reads only the original receipt references. */
export const loadSubmittedFreeTexts = async (
  entries: readonly EmailEntry[],
  privateKey: CryptoKey,
): Promise<FreeTextAnswers> => {
  const rows = await receiptRows(entries);
  const result = new Map<number, string>();
  for (const row of rows) {
    if (row.kind !== "free_text") continue;
    if (row.encrypted_text === null || row.question_id === null) {
      throw new Error("Missing submitted text receipt");
    }
    result.set(
      row.question_id,
      await decryptWithOwnerKey(row.encrypted_text, privateKey),
    );
  }
  return result;
};
