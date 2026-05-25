/**
 * SumUp checkout metadata store.
 *
 * SumUp checkouts expose only a single `checkout_reference` string and cannot
 * carry the arbitrary booking metadata that Stripe sessions and Square orders
 * round-trip for us. We therefore persist the metadata locally at checkout
 * creation, keyed by a reference we generate, and read it back when the
 * payment completes (via webhook or redirect). Rows are pruned by age in
 * prune.ts once the webhook-retry / redirect window has passed.
 */

import { getDb, insert, queryOne } from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";

type SumupCheckoutRow = { metadata: string };

/** Persist booking metadata for a checkout, keyed by its reference. */
export const storeSumupCheckout = async (
  reference: string,
  metadata: Record<string, string>,
): Promise<void> => {
  await getDb().execute(
    insert("sumup_checkouts", {
      checkout_reference: reference,
      created_at: nowIso(),
      metadata: JSON.stringify(metadata),
    }),
  );
};

/** Look up the stored booking metadata for a checkout reference, or null. */
export const getSumupCheckoutMetadata = async (
  reference: string,
): Promise<Record<string, string> | null> => {
  const row = await queryOne<SumupCheckoutRow>(
    "SELECT metadata FROM sumup_checkouts WHERE checkout_reference = ?",
    [reference],
  );
  return row ? (JSON.parse(row.metadata) as Record<string, string>) : null;
};
