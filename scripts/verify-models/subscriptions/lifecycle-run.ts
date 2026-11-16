/** Run the real scheduled check and the real owner cancel request against one
 * stored subscription state. Stripe replies are supplied assumptions. */
import { stub } from "@std/testing/mock";
import { eventGroup } from "#accounting/refs.ts";
import { execute, queryOnePrimary } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { getSubscribedRowOrNull } from "#db/subscriptions.ts";
import { ensureMessageGroups, t } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/message-groups.generated.ts";
import {
  denoEnvironment,
  setEnvironmentValue,
} from "#scripts/environment-values.ts";
import { requireValue } from "#shared/required-value.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  SUBSCRIPTION_NODE_OF,
  type SubscriptionStatus,
} from "#shared/subscriptions/plan.ts";
import { recordObserved } from "#shared/subscriptions/record.ts";
import { runSubscriptionCheck } from "#shared/subscriptions/status-check.ts";
import { parseFlashCookie } from "#test-utils/assertions/redirect.ts";
import { createTestDbWithSetup, resetDb } from "#test-utils/db.ts";
import { adminFormPost } from "#test-utils/session.ts";
import {
  paidInvoice,
  providerSubscription,
  seedBooking,
} from "./environment.ts";
import {
  type LifecycleCase,
  type LifecycleFacts,
  lifecycleScenario,
} from "./lifecycle-facts.ts";

type Move = LifecycleFacts["moves"][number];

/** What Stripe holds for one model subscription, and the requests it got. */
type World = {
  cancels: number;
  invoiceReads: number;
  paid: number;
  provider: SubscriptionStatus;
  reads: number;
  reply: LifecycleCase["reply"];
  row: number;
};

const REFUSAL = { reason: "rejected_request", status: "invalid" } as const;

const subscriptionOf = (row: number): string => `sub_life_${row}`;
const invoiceOf = (row: number): string => `in_life_${row}`;

const foundSubscription = (id: string, world: World) => ({
  resource: providerSubscription({
    amount: 600,
    id,
    interval: "month",
    listingId: world.row,
    status: world.provider,
  }),
  status: "found" as const,
});

/** Stripe ends a live subscription on request. It refuses to cancel an ended
 * one, as the real service does. */
const cancelAt = (id: string, world: World) => {
  world.cancels++;
  const ended = SUBSCRIPTION_NODE_OF[world.provider] === "ended";
  if (world.reply === "subscription-refused" || ended) return REFUSAL;
  world.provider = "canceled";
  return foundSubscription(id, world);
};

const readAt = (id: string, world: World) => {
  world.reads++;
  return world.reply === "subscription-refused"
    ? REFUSAL
    : foundSubscription(id, world);
};

const invoicesAt = (_id: string, world: World) => {
  world.invoiceReads++;
  if (world.reply === "invoices-refused") return REFUSAL;
  const invoices = world.paid > 0 ? [paidInvoice(invoiceOf(world.row))] : [];
  return { resource: invoices, status: "found" as const };
};

/** The ledger rows of the whole site, and the paid renewals of one row. */
const ledgerOf = async (row: number) => {
  const group = await eventGroup(["renewal", invoiceOf(row)]);
  const counts = requireValue(
    await queryOnePrimary<{ legs: number; own: number; recorded: number }>(
      sql`SELECT COUNT(*) AS legs,
              COALESCE(SUM(transfer.event_group = ${group}), 0) AS own,
              COALESCE(SUM(transfer.event_group = ${group} AND transfer.kind = 'payment'), 0) AS recorded
         FROM transfers AS transfer`,
    ),
    "The ledger count returned no row",
  );
  return {
    other: Number(counts.legs) - Number(counts.own),
    recorded: Number(counts.recorded),
  };
};

/** The scheduled check, from the row before this one. Earlier rows belong to
 * finished cases, so the pass reads this row only. */
const runCheck = async (row: number): Promise<string> => {
  await runSubscriptionCheck({
    budget: { remaining: () => ({ database: 0, external: 0, total: 0 }) },
    checkpoint: String(row - 1),
    completeTask: () => undefined,
    deadline: 0,
    requestFollowUp: () => undefined,
    setCheckpoint: () => undefined,
  });
  return "returned";
};

/* jscpd:ignore-start -- a list of strings, not code */
const CANCEL_ANSWERS = [
  ["subscriptions.success.cancelled", "cancelled"],
  ["subscriptions.success.cancelled_behind", "behind"],
  ["subscriptions.error.not_cancelled", "not_cancelled"],
  ["subscriptions.error.ended", "ended"],
] as const;
/* jscpd:ignore-end */

/** The owner posts the cancel form. The outcome is the message that the
 * owner reads. */
const runCancel = async (row: number): Promise<string> => {
  const { response } = await adminFormPost(
    `/admin/subscriptions/${row}/cancel`,
  );
  const flash = parseFlashCookie(response);
  const message = flash.success ?? flash.error;
  const answer = CANCEL_ANSWERS.find(([key]) => t(key) === message);
  return requireValue(
    answer,
    `The cancel request gave an unknown answer: ${message}`,
  )[1];
};

const COMMAND_RUNNERS = { cancel: runCancel, check: runCheck };

/** One step of a case, on the row that the case owns. */
type CaseStep<Result> = (
  worlds: Map<string, World>,
  sample: LifecycleCase,
  row: number,
) => Promise<Result>;

/** Put the row and Stripe in the state of the case. The real writer posts
 * the renewal that the state already holds. */
const seedState: CaseStep<World> = async (worlds, sample, row) => {
  const id = subscriptionOf(row);
  const world: World = {
    cancels: 0,
    invoiceReads: 0,
    paid: sample.recorded,
    provider: "active",
    reads: 0,
    reply: "answers",
    row,
  };
  worlds.set(id, world);
  await seedBooking({
    attendeeId: row,
    id: row,
    listingId: row,
    plan: { amount: 600, id, interval: "month", status: "active", tax: 0 },
    quantity: 1,
  });
  const seeded = requireValue(
    await getSubscribedRowOrNull(row),
    "The seeded subscription is absent",
  );
  if (sample.recorded > 0) await recordObserved(seeded, "active");
  await execute(
    sql`UPDATE listing_attendees SET subscription_status = ${sample.stored} WHERE id = ${row}`,
  );
  Object.assign(world, {
    invoiceReads: 0,
    paid: sample.paid,
    provider: sample.provider,
    reply: sample.reply,
  });
  return world;
};

const observeCase: CaseStep<Move> = async (worlds, sample, row) => {
  const world = await seedState(worlds, sample, row);
  const before = await ledgerOf(row);
  const outcome = await COMMAND_RUNNERS[sample.command](row);
  const after = await ledgerOf(row);
  const stored = requireValue(
    await getSubscribedRowOrNull(row),
    "The subscription row is absent after its command",
  );
  return {
    cancels: world.cancels,
    command: sample.command,
    invoiceReads: world.invoiceReads,
    otherLegs: after.other - before.other,
    outcome,
    paid: sample.paid,
    position: row,
    provider: sample.provider,
    providerAfter: world.provider,
    reads: world.reads,
    recorded: before.recorded,
    recordedAfter: after.recorded,
    reply: sample.reply,
    scenario: lifecycleScenario(sample),
    stored: sample.stored,
    storedAfter: stored.subscription_status,
  };
};

/** One request of a model subscription reaches its own Stripe state. A
 * request for another id fails. */
const withLifecycleProvider = async (
  worlds: Map<string, World>,
  run: () => Promise<Move[]>,
): Promise<Move[]> => {
  const answerWith =
    <Answer>(reply: (id: string, world: World) => Answer) =>
    (id: string): Promise<Answer> =>
      Promise.resolve(
        reply(
          id,
          requireValue(
            worlds.get(id),
            `No model subscription has the id ${id}`,
          ),
        ),
      );
  using _cancel = stub(stripeApi, "cancelSubscription", answerWith(cancelAt));
  using _read = stub(stripeApi, "readSubscription", answerWith(readAt));
  using _invoices = stub(stripeApi, "readPaidInvoices", answerWith(invoicesAt));
  return await run();
};

/** One site with an owner holds every case. Each case has a row of its own,
 * and the row id is the position of the case in the list. */
export const lifecycleMoves = async (
  cases: readonly LifecycleCase[],
): Promise<Move[]> => {
  await ensureMessageGroups(MESSAGE_GROUPS);
  const expectedError = Deno.env.get("TEST_EXPECT_ERROR");
  Deno.env.set("TEST_EXPECT_ERROR", "1");
  await createTestDbWithSetup();
  try {
    const worlds = new Map<string, World>();
    return await withLifecycleProvider(worlds, async () => {
      const moves: Move[] = [];
      for (const [index, sample] of cases.entries())
        moves.push(await observeCase(worlds, sample, index + 1));
      return moves;
    });
  } finally {
    resetDb();
    setEnvironmentValue(denoEnvironment, "TEST_EXPECT_ERROR", expectedError);
  }
};
