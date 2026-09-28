import * as v from "valibot";
import {
  decryptCheckoutWork,
  encryptCheckoutWork,
  type SealedCheckoutWork,
} from "#crypto/checkout-work.ts";
import { hmacHash } from "#crypto/hashing.ts";
import { execute, queryOne } from "#db/client.ts";
import type { SubmittedAnswers } from "#shared/email/answer-receipt.ts";
import type { FreeTextAnswers } from "#shared/email/answers.ts";
import { DAY_MS, nowIso } from "#shared/now.ts";

const StoredAnswer = v.object({
  kind: v.picklist(["choice", "free_text"]),
  question: v.string(),
  questionId: v.number(),
  text: v.string(),
});
const StagedPayload = v.object({
  sessionId: v.string(),
  snapshot: v.array(
    v.object({
      answers: v.array(StoredAnswer),
      listingId: v.number(),
    }),
  ),
  squareLinkId: v.optional(v.string()),
  texts: v.record(v.string(), v.string()),
});

type StagedPayload = v.InferOutput<typeof StagedPayload>;
export type StagedCheckoutRow = {
  session_index: string;
  sealed: string;
  wrapped_key: string;
};

const sealPayload = (payload: StagedPayload): Promise<SealedCheckoutWork> =>
  encryptCheckoutWork(JSON.stringify(payload));

const openPayload = async (
  row: Pick<StagedCheckoutRow, "sealed" | "wrapped_key">,
): Promise<StagedPayload> =>
  v.parse(
    StagedPayload,
    JSON.parse(
      await decryptCheckoutWork({
        sealed: row.sealed,
        wrappedKey: row.wrapped_key,
      }),
    ),
  );

/** The index is an HMAC only; it never provides a decryption key. */
export const sessionWorkIndex = (sessionId: string): Promise<string> =>
  hmacHash(sessionId);

/** A checkout cannot be returned to the buyer unless this write succeeds. */
export const stageCheckoutAnswers = async (
  sessionId: string,
  texts: Record<string, string> | undefined,
  snapshot: SubmittedAnswers = [],
  squareLinkId?: string,
): Promise<void> => {
  if (squareLinkId !== undefined && !squareLinkId) {
    throw new Error("Square payment link ID is missing");
  }
  const payload: StagedPayload = {
    sessionId,
    snapshot: snapshot.map(({ listingId, answers }) => ({
      answers: [...answers],
      listingId,
    })),
    squareLinkId,
    texts: v.parse(v.record(v.string(), v.string()), texts ?? {}),
  };
  const { sealed, wrappedKey } = await sealPayload(payload);
  const createdAt = nowIso();
  const result = await execute(
    `INSERT INTO checkout_pending_answers
       (session_index, sealed, wrapped_key, created_at, provider, state,
        next_check_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)
     ON CONFLICT(session_index) DO UPDATE SET
       sealed = excluded.sealed, wrapped_key = excluded.wrapped_key,
       created_at = excluded.created_at, provider = excluded.provider,
       next_check_at = excluded.next_check_at
     WHERE checkout_pending_answers.state = 'open'`,
    [
      await sessionWorkIndex(sessionId),
      sealed,
      wrappedKey,
      createdAt,
      squareLinkId === undefined ? "" : "square",
      squareLinkId === undefined
        ? null
        : new Date(Date.parse(createdAt) + 90 * DAY_MS).toISOString(),
    ],
  );
  if (result.rowsAffected !== 1) {
    throw new Error("A checkout with this identity is already being completed");
  }
};

/** Read without consuming: a receipt and due emails must commit before deletion. */
export const readCheckoutAnswers = async (
  sessionId: string,
): Promise<{ texts: FreeTextAnswers; snapshot: SubmittedAnswers } | null> => {
  const row = await queryOne<StagedCheckoutRow>(
    `SELECT session_index, sealed, wrapped_key FROM checkout_pending_answers
     WHERE session_index = ?`,
    [await sessionWorkIndex(sessionId)],
  );
  if (!row) return null;
  const payload = await openPayload(row);
  if (payload.sessionId !== sessionId) {
    throw new Error("Staged checkout identity does not match its index");
  }
  return {
    snapshot: payload.snapshot,
    texts: new Map(
      Object.entries(payload.texts).map(([questionId, text]) => [
        Number(questionId),
        text,
      ]),
    ),
  };
};

/** A scheduled Square call uses an authenticated, index-bound provider ID. */
export const openSquareCheckoutIdentity = async (
  row: StagedCheckoutRow,
): Promise<{ sessionId: string; linkId: string }> => {
  const { sessionId, squareLinkId } = await openPayload(row);
  if (
    !sessionId ||
    !squareLinkId ||
    row.session_index !== (await sessionWorkIndex(sessionId))
  ) {
    throw new Error("Square checkout identity is missing or corrupt");
  }
  return { linkId: squareLinkId, sessionId };
};

/** Keep the paid row discoverable until its receipt and emails are durable. */
export const markCheckoutAnswersPaid = async (
  sessionId: string,
): Promise<boolean> => {
  const result = await execute(
    `UPDATE checkout_pending_answers
       SET state = 'paid_answers_due', claim_token = '', next_check_at = NULL,
           attendee_id = (
             SELECT attendee_id FROM processed_payments
             WHERE payment_session_id = ?
           )
     WHERE session_index = ? AND state IN ('open', 'cancelling', 'paid_answers_due')`,
    [sessionId, await sessionWorkIndex(sessionId)],
  );
  return result.rowsAffected === 1;
};

/** Remove staging only after durable paid handoff or a terminal outcome. */
export const deleteCheckoutAnswers = async (
  sessionId: string,
): Promise<void> => {
  await execute(
    "DELETE FROM checkout_pending_answers WHERE session_index = ?",
    [await sessionWorkIndex(sessionId)],
  );
};
