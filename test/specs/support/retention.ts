/**
 * What scheduled maintenance keeps and what it removes: the SumUp checkouts
 * whose recovery state decides their fate, and the staged buyer's answers a
 * late payment callback can still need. The stories plant the rows the way
 * the site writes them and run the real scheduled job.
 */

import { hmacHash } from "#crypto/hashing.ts";
import {
  readCheckoutAnswers,
  stageCheckoutAnswers,
} from "#db/checkout-pending-answers.ts";
// jscpd:ignore-start
import { execute, queryAll } from "#db/client.ts";
import { stageSquareLinkEnd } from "#db/square-link-ends.ts";
import { getDueSumupCheckouts } from "#db/sumup-recovery.ts";
import { MAINTENANCE_TASKS } from "#shared/maintenance/registry.ts";
import { maintenance } from "#shared/maintenance/runner.ts";
import type { ActOnTheStory } from "#test/specs/support/world.ts";
import { plantSumupRecoveryRow } from "#test-utils/sumup.ts";
// jscpd:ignore-end

/** The real scheduled maintenance job: the registry's tasks, through the
 * runner that claims and runs them. */
export const runScheduledMaintenance: ActOnTheStory = async (_world) => {
  await maintenance.run(MAINTENANCE_TASKS);
};

const dayAgoIso = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

/** The names the story gives the planted SumUp checkouts, and the ids they
 * carry in the database. */
const CHECKOUT_IDS = {
  oldFinished: "prune-old-finished",
  oldWaiting: "prune-old-waiting",
  recentFinished: "prune-recent-finished",
} as const;

/** Plant one SumUp checkout row the recovery machinery stores: the state
 * decides its fate, the day it was created decides when. */
const plantCheckout = (
  id: string,
  state: string,
  created: string,
): Promise<unknown> =>
  plantSumupRecoveryRow(
    id,
    state,
    state === "waiting" ? "2000-01-01T00:00:00.000Z" : null,
    created,
  );

/** The SumUp checkouts the retention story talks about: old and finished,
 * equally old but still waiting to hear, and recently finished. */
export const plantRetentionCheckouts: ActOnTheStory = async (_world) => {
  const old = dayAgoIso(2);
  await plantCheckout(CHECKOUT_IDS.oldFinished, "finished", old);
  await plantCheckout(CHECKOUT_IDS.oldWaiting, "waiting", old);
  await plantCheckout(
    CHECKOUT_IDS.recentFinished,
    "finished",
    new Date().toISOString(),
  );
};

/** The recovery states of the planted checkouts, by the story's name for
 * them. A checkout maintenance took away is simply absent. */
export const plantedCheckoutStates = async (): Promise<Map<string, string>> => {
  const planted = await queryAll<{
    recovery_state: string;
    sumup_id: string;
  }>(
    "SELECT sumup_id, recovery_state FROM sumup_checkouts WHERE sumup_id LIKE 'prune-%'",
  );
  return new Map(
    planted.map((row) => [
      row.sumup_id.slice("prune-".length),
      row.recovery_state,
    ]),
  );
};

/** The planted checkouts the recovery pass would ask about now: the work
 * maintenance must leave reachable. */
export const plantedCheckoutsDueForRecovery = async (): Promise<string[]> =>
  (await getDueSumupCheckouts())
    .map((checkout) => checkout.sumupId)
    .filter((sumupId) => sumupId.startsWith("prune-"));

/** The checkouts the answers story stages answers for, by the story's name
 * for them. */
export const STAGED_ANSWER_SESSIONS = {
  gone: "prune-gone-checkout",
  kept: "prune-kept-checkout",
  recent: "prune-recent-checkout",
} as const;

/** Stage an old buyer's answers for one checkout, the way the checkout
 * itself wrote them, then age the row past the payments window. */
const stageOldAnswers = async (
  sessionId: string,
  text: string,
  linkEnded: string,
): Promise<void> => {
  await stageCheckoutAnswers(sessionId, { "3": text }, linkEnded);
  await execute(
    "UPDATE checkout_pending_answers SET created_at = ? WHERE session_index = ?",
    [dayAgoIso(120), await hmacHash(sessionId)],
  );
};

/** An old buyer's answers for a checkout whose payment link has ended but
 * whose link the site still holds: a payment made just before the end can
 * still arrive, so the answers must stay. */
export const plantAnswersWithHeldLink: ActOnTheStory = async (_world) => {
  const linkEnded = dayAgoIso(5);
  await stageOldAnswers(
    STAGED_ANSWER_SESSIONS.kept,
    "Arriving late",
    linkEnded,
  );
  await stageSquareLinkEnd(
    STAGED_ANSWER_SESSIONS.kept,
    "prune-link-id",
    linkEnded,
  );
};

/** An equally old buyer's answers for a checkout whose payment link ended
 * and whose link the site no longer holds: nothing can arrive for it any
 * more. */
export const plantAnswersWithGoneLink: ActOnTheStory = async (_world) => {
  await stageOldAnswers(
    STAGED_ANSWER_SESSIONS.gone,
    "Vegetarian",
    dayAgoIso(5),
  );
};

/** A buyer's answers staged just now, for a checkout still inside its
 * window. */
export const plantRecentAnswers: ActOnTheStory = async (_world) => {
  await stageCheckoutAnswers(
    STAGED_ANSWER_SESSIONS.recent,
    { "3": "Two tickets" },
    null,
  );
};

/** The answers staged for one of the story's checkouts: what a buyer typed,
 * or nothing when maintenance has taken them away. */
export const stagedAnswerTexts = (sessionId: string) =>
  readCheckoutAnswers(sessionId);
