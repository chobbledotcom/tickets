/**
 * Several small cached reads, answered in one round trip.
 *
 * A page that needs three little tables — "is there any news?", the site pages,
 * the items on them — would otherwise wait for three answers, one after
 * another. Each read still owns its request cache, so every other caller in the
 * request keeps reading from it exactly as before; this only changes where that
 * cache's first answer comes from.
 *
 * Ask once, early, for the set a page is about to need: filling a cache that is
 * already full just throws the batch's work away.
 */

import type { ResultSet } from "@libsql/client";
import { queryBatch, type SqlStatement } from "#shared/db/client.ts";
import { requireValue } from "#shared/required-value.ts";

/** One cached read that can take its answer from a shared batch. */
export type FillableRead = {
  /** The statement this read would otherwise run on its own. */
  readonly statement: SqlStatement;
  /** Put this answer into the read's request cache. */
  readonly fill: (result: ResultSet) => Promise<void> | void;
};

/** Answer every read in one round trip, then fill each one's cache. */
export const fillTogether = async (
  reads: readonly FillableRead[],
): Promise<void> => {
  if (reads.length === 0) return;
  const results = await queryBatch(reads.map(({ statement }) => statement));
  await Promise.all(
    reads.map((read, index) =>
      read.fill(
        requireValue(results[index], `Batched read ${index} went unanswered`),
      ),
    ),
  );
};
