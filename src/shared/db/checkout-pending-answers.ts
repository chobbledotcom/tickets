/**
 * The free-text answers a buyer typed, staged beside their checkout.
 *
 * Free-text answer strings rest in the strings table sealed to the owner key,
 * and the payment completion (which sends the emails) has no session to spend
 * on that key. Checkout metadata cannot carry the text either, because
 * providers cap it. So the booking request stages the plaintext here, keyed by
 * the checkout session id and sealed with `DB_ENCRYPTION_KEY`, and the
 * completion takes it back in one round trip and deletes the row. Pruning
 * sweeps what an abandoned checkout leaves behind.
 */

/* jscpd:ignore-start -- imports */
import { decrypt, encrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { execute, queryOne } from "#db/client.ts";
import type { FreeTextAnswers } from "#shared/email/answers.ts";
import { nowIso } from "#shared/now.ts";
import { stringRecordJson } from "#shared/validation/stored-json.ts";

/* jscpd:ignore-end */

/** The sealed column, and nothing else: the lookup key is the session id the
 * statement binds. */
interface StagedRow {
  sealed: string;
}

/** Stage the answers a buyer typed, keyed by the checkout they belong to. The
 * row must not outlive a retry of the same checkout, so a re-created session
 * replaces what an earlier one staged. */
export const stageCheckoutAnswers = async (
  sessionId: string,
  texts: Record<string, string> | undefined,
): Promise<void> => {
  if (!texts || Object.keys(texts).length === 0) return;
  await execute(
    `INSERT INTO checkout_pending_answers (session_id, sealed, created_at)
             VALUES (?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               sealed = excluded.sealed,
               created_at = excluded.created_at`,
    [
      sessionId,
      await encrypt(stringRecordJson.write(texts, "checkout answers")),
      nowIso(),
    ],
  );
};

/** Take back the answers staged for a checkout, deleting the row in the same
 * round trip. An email send that later fails loses nothing that matters: the
 * strings table keeps every answer sealed to the owner key, and the admin
 * resend can read it there. */
export const takeCheckoutAnswers = async (
  sessionId: string,
): Promise<FreeTextAnswers> => {
  const row = await queryOne<StagedRow>(
    `DELETE FROM checkout_pending_answers
      WHERE session_id = ?
      RETURNING sealed`,
    [sessionId],
  );
  if (row === null) return new Map();
  const staged = stringRecordJson.read(
    await decrypt(row.sealed as EnvKeyEncrypted),
    "checkout answers",
  );
  return new Map(
    Object.entries(staged).map(([questionId, text]): [number, string] => [
      Number(questionId),
      text,
    ]),
  );
};
