/**
 * The free-text answers a buyer typed, staged beside their checkout: sealed
 * with `DB_ENCRYPTION_KEY`, taken back by the completion in one round trip,
 * deleted with that read, and pruned once its checkout can no longer be paid. The
 * strings table keeps its owner-sealed copy, which the completion has no
 * session to spend, and checkout metadata cannot carry the text because
 * providers cap it.
 *
 * Keyed by the HMAC of the session id, never the id itself: for SumUp it is
 * the checkout reference, which must never rest in this database — with it,
 * a dump plus the environment key could unwrap the SumUp staging rows.
 */

/* jscpd:ignore-start -- imports */
import { decrypt, encrypt } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { execute, queryOne } from "#db/client.ts";
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

/** Take back the answers staged for a checkout, deleting the row in the same
 * round trip. An email send that later fails loses nothing that matters: the
 * strings table keeps every answer sealed to the owner key, and the admin
 * resend can read it there. */
export const takeCheckoutAnswers = async (
  sessionId: string,
): Promise<FreeTextAnswers> => {
  const row = await queryOne<StagedRow>(
    `DELETE FROM checkout_pending_answers
      WHERE session_index = ?
      RETURNING sealed`,
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
