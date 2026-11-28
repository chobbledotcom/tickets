// effects: pure

import type { DecodedRowOf } from "#db/select/tables.ts";

/** One customer review on the public /reviews page. */
export type Review = DecodedRowOf<"reviews">;
