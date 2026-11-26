// effects: pure
import * as v from "valibot";
import { doorPersonSchema } from "#shared/roster-option.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

/** One saved ticket in a door's offline list: the ticket's keyed digest and
 * the places one scan at the door admits of its booking. The name and the
 * door-safe details let the door find the person by name with no
 * connection. */
export const TicketCacheEntrySchema = doorPersonSchema({
  hash: NonEmptyTextSchema,
});

export type TicketCacheEntry = v.InferOutput<typeof TicketCacheEntrySchema>;

/** One page of a door's offline list. `next` is the signed cursor for the
 * next page, or null on the last page. `people` counts the door's people
 * this page read, out of `total`. */
export const TicketCachePageSchema = v.object({
  entries: v.array(TicketCacheEntrySchema),
  next: v.nullable(v.string()),
  people: integerAtLeast(0),
  total: integerAtLeast(0),
});

/** The list one door's page stores, stamped with the time this device
 * stored it. */
export const StoredListSchema = v.object({
  entries: v.array(TicketCacheEntrySchema),
  storedAt: v.number(),
});
