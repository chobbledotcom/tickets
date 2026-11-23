/**
 * The place an operator drags each listing to. A moved list takes places
 * from 1 up, so a listing that nobody moved (place 0) shows first.
 */

import { defineOrderedCollection } from "#db/ordered-collection.ts";

export const listingOrder = defineOrderedCollection({
  key: "id",
  start: 1,
  table: "listings",
});
