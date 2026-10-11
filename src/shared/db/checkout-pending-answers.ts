/**
 * The free-text answers a buyer typed, staged beside their checkout: sealed
 * with `DB_ENCRYPTION_KEY`, read back non-destructively by the completion,
 * deleted by the creation batch that commits the work row replacing them,
 * and pruned once its checkout can no longer be paid. The strings table
 * keeps its owner-sealed copy, which the completion has no session to spend,
 * and checkout metadata cannot carry the text because providers cap it.
 *
 * Keyed by the HMAC of the session id, never the id itself: for SumUp it is
 * the checkout reference, which must never rest in this database — with it,
 * a dump plus the environment key could unwrap the SumUp staging rows.
 */

/* jscpd:ignore-start -- imports */
import { decrypt, encrypt } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { execute, queryOne, type SqlStatement } from "#db/client.ts";
import type { FreeTextAnswers } from "#shared/email/answers.ts";
import { nowIso } from "#shared/now.ts";
import { stringRecordJson } from "#shared/validation/stored-json.ts";

/* jscpd:ignore-end */

/** The sealed column, and nothing else: the lookup key is the index the
 * statement binds. */
interface StagedRow {
  sealed: string;
}

/** Stage the answers a buyer typed, keyed by the checkout they belong to. The
 * row must not outlive a retry of the same checkout, so a re-created session
 * replaces what an earlier one staged. `linkEndsAt` is when the checkout
 * stops taking payment, or null when it ends long before the payments clock. */
export const stageCheckoutAnswers = async (
  sessionId: string,
  texts: Record<string, string> | undefined,
  linkEndsAt: string | null,
): Promise<void> => {
  if (!texts || Object.keys(texts).length === 0) return;
  await execute(
    `INSERT INTO checkout_pending_answers
               (session_index, sealed, created_at, link_ends_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_index) DO UPDATE SET
               sealed = excluded.sealed,
               created_at = excluded.created_at,
               link_ends_at = excluded.link_ends_at`,
    [
      await hmacHash(sessionId),
      await encrypt(stringRecordJson.write(texts, "checkout answers")),
      nowIso(),
      linkEndsAt,
    ],
  );
};

/** Read back the answers staged for a checkout without deleting them. The
 * staging row dies only when the creation batch commits its replacement,
 * so a crash in between leaves the buyer's texts staged for the retry. */
export const readCheckoutAnswers = async (
  sessionId: string,
): Promise<FreeTextAnswers> => {
  const row = await queryOne<StagedRow>(
    "SELECT sealed FROM checkout_pending_answers WHERE session_index = ?",
    [await hmacHash(sessionId)],
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

/** The staging row's delete, to ride inside the creation batch beside the
 * work row that replaces it: one atomic commit, no destructive gap. */
export const discardCheckoutAnswersStatement = async (
  sessionId: string,
): Promise<SqlStatement> => ({
  args: [await hmacHash(sessionId)],
  sql: "DELETE FROM checkout_pending_answers WHERE session_index = ?",
});
