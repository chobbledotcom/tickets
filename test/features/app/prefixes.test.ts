/**
 * The app prefix declaration joins two alphabetical halves. The join spreads
 * both records into one, so a prefix that names the same key in both halves
 * loses the earlier declaration without an error. Pin the halves as disjoint.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PREFIXES_A_L } from "#routes/app/prefixes-a-l.ts";
import { PREFIXES_M_Z } from "#routes/app/prefixes-m-z.ts";

describe("the app prefix declaration", () => {
  test("names each prefix in one half only", () => {
    const declaredInBothHalves = Object.keys(PREFIXES_M_Z).filter((prefix) =>
      Object.hasOwn(PREFIXES_A_L, prefix),
    );

    expect(declaredInBothHalves).toEqual([]);
  });
});
