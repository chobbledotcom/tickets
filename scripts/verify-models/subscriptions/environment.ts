/** Isolated production-schema records for the subscription proof producers. */

import { join } from "node:path";
import { encrypt, setEncryptionKeyForTest } from "#crypto/encryption.ts";
import { executeBatch, setDb } from "#db/client.ts";
import { rebuildWipedSchema } from "#db/migrations.ts";
import { sql } from "#db/sql.ts";
import { lazyRef } from "#fp";
import { ensureMessageGroups } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/message-groups.generated.ts";
import { makeScratchDir } from "#scripts/scratch.ts";
import { resetAllCaches } from "#shared/cache-registry.ts";
import type {
  StripePaidInvoice,
  StripeSubscription,
} from "#shared/stripe/schemas.ts";
import type {
  SubscriptionPlan,
  SubscriptionStart,
} from "#shared/subscriptions/plan.ts";
import { createTestDbClient } from "#test-utils/db-client.ts";
import { maybeReclaimLeakedFds } from "#test-utils/reclaim-fds.ts";

export const MODEL_TIME = "2026-03-01T00:00:00.000Z";

/** A fixed synthetic key keeps local account references stable. */
const MODEL_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

/** Only the empty schema is shared. Each observation gets a separate file. */
const [schemaImageOrNull, setSchemaImage] = lazyRef<Uint8Array | null>(
  () => null,
);

/** One model database at a time, so two producers never share env or a lock. */
const [modelDbTail, setModelDbTail] = lazyRef<Promise<unknown>>(() =>
  Promise.resolve(),
);

/** Producers run serially. No fixture opens the configured application database. */
export const withSubscriptionDb = <Result>(
  work: () => Promise<Result>,
): Promise<Result> => {
  const queued = (async (): Promise<Result> => {
    await modelDbTail().catch(() => undefined);
    maybeReclaimLeakedFds();
    await ensureMessageGroups(MESSAGE_GROUPS);
    const directory = await makeScratchDir("subscription-model-");
    const path = join(directory, "model.db");
    const image = schemaImageOrNull();
    if (image !== null) await Deno.writeFile(path, image);
    // The model client is explicit. Do not publish its URL through Deno.env:
    // test workers share the process environment, and a parallel suite would
    // connect to this file and contend for its write lock.
    const client = await createTestDbClient(path);
    setEncryptionKeyForTest(MODEL_KEY);
    setDb(client);
    resetAllCaches();
    try {
      if (image === null) {
        await rebuildWipedSchema();
        setSchemaImage(await Deno.readFile(path));
      }
      return await work();
    } finally {
      resetAllCaches();
      setDb(null);
      setEncryptionKeyForTest(null);
      client.close();
      await Deno.remove(directory, { recursive: true });
    }
  })();
  setModelDbTail(queued);
  return queued;
};

export type BookingSeed = {
  id: number;
  attendeeId: number;
  listingId: number;
  quantity: number;
  plan?: SubscriptionPlan | undefined;
};

/** Several rows can share the same fixture attendee or listing. */
export const seedBooking = async (seed: BookingSeed): Promise<void> => {
  const plan = seed.plan;
  await executeBatch([
    sql`INSERT OR IGNORE INTO attendees (id, created) VALUES (${seed.attendeeId}, ${MODEL_TIME})`,
    sql`INSERT OR IGNORE INTO listings (id, created, max_attendees, name)
            VALUES (${seed.listingId}, ${MODEL_TIME}, 10000, ${await encrypt(`Model ticket ${seed.listingId}`)})`,
    sql`INSERT INTO listing_attendees
              (id, attendee_id, listing_id, quantity, recurring_price,
               recurring_tax, recurring_interval, subscription_id, subscription_status)
            VALUES (${seed.id}, ${seed.attendeeId}, ${seed.listingId}, ${seed.quantity}, ${plan?.amount ?? 0}, ${plan?.tax ?? 0}, ${plan?.interval ?? ""}, ${plan?.id ?? ""}, ${plan?.status ?? ""})`,
  ]);
};

/** The supplied provider object is an assumption, not a real Stripe observation. */
export const providerSubscription = (
  start: SubscriptionStart,
): StripeSubscription => ({
  id: start.id,
  items: {
    data: [
      {
        price: {
          recurring: { interval: start.interval },
          unit_amount: start.amount,
        },
        quantity: 1,
      },
    ],
  },
  metadata: { listing_id: String(start.listingId) },
  status: start.status,
});

export const paidInvoice = (id: string, amount = 600): StripePaidInvoice => ({
  amount_paid: amount,
  billing_reason: "subscription_cycle",
  currency: "gbp",
  id,
  status_transitions: { paid_at: Date.parse(MODEL_TIME) / 1000 },
});

/** One refusal that a scenario expects: the test of its error, and the
 * outcome that the facts record for it. */
export type ExpectedRefusal<Outcome> = readonly [
  isExpected: (error: unknown) => boolean,
  outcome: Outcome,
];

/** Runs one production call. An error that an expected refusal accepts gives
 * the outcome of that refusal. Any other error escapes, so an unexpected
 * failure cannot become a fact. */
export const outcomeOf = async <Outcome>(
  run: () => Promise<Outcome>,
  refusals: readonly ExpectedRefusal<Outcome>[],
): Promise<Outcome> => {
  try {
    return await run();
  } catch (error) {
    const refusal = refusals.find(([isExpected]) => isExpected(error));
    if (refusal === undefined) throw error;
    return refusal[1];
  }
};
