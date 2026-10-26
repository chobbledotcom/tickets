// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { hmacHash } from "#crypto/hashing.ts";
import {
  readCheckoutAnswers,
  stageCheckoutAnswers,
} from "#db/checkout-pending-answers.ts";
import { execute, queryOne } from "#db/client.ts";
import { runDatabasePruning } from "#db/prune.ts";
import { stageSquareLinkEnd } from "#db/square-link-ends.ts";
import {
  PRUNE_PAYMENTS_RETENTION_MS,
  WEBHOOK_RETRY_WINDOW_DAYS,
} from "#shared/limits.ts";
import { DAY_MS, nowMs } from "#shared/now.ts";
import { SQUARE_NATIVE_LIFETIME_MS } from "#shared/square/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";

// jscpd:ignore-end

const requiredSquareRetentionMs =
  SQUARE_NATIVE_LIFETIME_MS + WEBHOOK_RETRY_WINDOW_DAYS * DAY_MS;

const boundaries = [
  ["before", -1, true],
  ["at", 0, true],
  ["after", 1, false],
] as const;

const answers = { "7": "Keep my answers" };
const expectedAnswers = (kept: boolean): Map<number, string> =>
  kept ? new Map([[7, answers["7"]]]) : new Map();

const setCreatedAt = async (session: string, createdAt: string) => {
  await execute(
    "UPDATE checkout_pending_answers SET created_at = ? WHERE session_index = ?",
    [createdAt, await hmacHash(session)],
  );
};

describeWithEnv(
  "Square retention at the database boundary",
  { db: true },
  () => {
    for (const [position, ageOffset, kept] of boundaries) {
      test(`handles and answers respect the strict Square retention cutoff ${position} its boundary`, async () => {
        const clock = nowMs();
        using _clock = stub(Date, "now", () => clock);
        const createdAt = new Date(
          clock - requiredSquareRetentionMs - ageOffset,
        ).toISOString();
        const linkEndsAt = new Date(
          clock - requiredSquareRetentionMs,
        ).toISOString();
        for (const state of ["pending", "ending"] as const) {
          const session = `sq_boundary_${position}_${state}`;
          const index = await hmacHash(session);
          await stageCheckoutAnswers(session, answers, linkEndsAt);
          await stageSquareLinkEnd(session, `link_${session}`, linkEndsAt);
          await setCreatedAt(session, createdAt);
          await execute(
            "UPDATE square_link_ends SET created_at = ?, state = ? WHERE session_index = ?",
            [createdAt, state, index],
          );
        }

        await runDatabasePruning();

        for (const state of ["pending", "ending"] as const) {
          const session = `sq_boundary_${position}_${state}`;
          expect(
            await queryOne(
              "SELECT state FROM square_link_ends WHERE session_index = ?",
              [await hmacHash(session)],
            ),
          ).toEqual(kept ? { state } : null);
          expect(await readCheckoutAnswers(session)).toEqual(
            expectedAnswers(kept),
          );
        }
      });

      test(`answers survive Square webhook retries ${position} their strict cutoff after the handle is gone`, async () => {
        const clock = nowMs();
        using _clock = stub(Date, "now", () => clock);
        const session = `sq_webhook_${position}`;
        const linkEndsAt = new Date(
          clock - WEBHOOK_RETRY_WINDOW_DAYS * DAY_MS - ageOffset,
        ).toISOString();
        await stageCheckoutAnswers(session, answers, linkEndsAt);
        await setCreatedAt(
          session,
          new Date(clock - PRUNE_PAYMENTS_RETENTION_MS - 1).toISOString(),
        );

        await runDatabasePruning();

        expect(await readCheckoutAnswers(session)).toEqual(
          expectedAnswers(kept),
        );
      });
    }
  },
);
