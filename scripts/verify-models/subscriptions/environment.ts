/** Isolated production-schema records for the subscription proof producers. */

import { join } from "node:path";
import { createClient } from "@libsql/client";
import { encrypt, setEncryptionKeyForTest } from "#crypto/encryption.ts";
import { executeBatch, setDb } from "#db/client.ts";
import { rebuildWipedSchema } from "#db/migrations.ts";
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

export const MODEL_TIME = "2026-03-01T00:00:00.000Z";

/** A fixed synthetic key keeps local account references stable. */
const MODEL_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

/** Only the empty schema is shared. Each observation gets a separate file. */
const [schemaImageOrNull, setSchemaImage] = lazyRef<Uint8Array | null>(
  () => null,
);

/** Producers run serially. No fixture opens the configured application database. */
export const withSubscriptionDb = async <Result>(
  run: () => Promise<Result>,
): Promise<Result> => {
  await ensureMessageGroups(MESSAGE_GROUPS);
  const directory = await makeScratchDir("subscription-model-");
  const path = join(directory, "model.db");
  const image = schemaImageOrNull();
  if (image !== null) await Deno.writeFile(path, image);
  const url = `file:${path}`;
  const previousUrl = Deno.env.get("DB_URL");
  Deno.env.set("DB_URL", url);
  const client = createClient({ url });
  setEncryptionKeyForTest(MODEL_KEY);
  setDb(client);
  resetAllCaches();
  try {
    // These synthetic records do not need crash durability.
    await client.executeMultiple(
      "PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;",
    );
    if (image === null) {
      await rebuildWipedSchema();
      setSchemaImage(await Deno.readFile(path));
    }
    return await run();
  } finally {
    resetAllCaches();
    setDb(null);
    setEncryptionKeyForTest(null);
    client.close();
    if (previousUrl === undefined) Deno.env.delete("DB_URL");
    else Deno.env.set("DB_URL", previousUrl);
    await Deno.remove(directory, { recursive: true });
  }
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
    {
      args: [seed.attendeeId, MODEL_TIME],
      sql: "INSERT OR IGNORE INTO attendees (id, created) VALUES (?, ?)",
    },
    {
      args: [
        seed.listingId,
        MODEL_TIME,
        await encrypt(`Model ticket ${seed.listingId}`),
      ],
      sql: `INSERT OR IGNORE INTO listings (id, created, max_attendees, name)
            VALUES (?, ?, 10000, ?)`,
    },
    {
      args: [
        seed.id,
        seed.attendeeId,
        seed.listingId,
        seed.quantity,
        plan?.amount ?? 0,
        plan?.tax ?? 0,
        plan?.interval ?? "",
        plan?.id ?? "",
        plan?.status ?? "",
      ],
      sql: `INSERT INTO listing_attendees
              (id, attendee_id, listing_id, quantity, recurring_price,
               recurring_tax, recurring_interval, subscription_id, subscription_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    },
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
