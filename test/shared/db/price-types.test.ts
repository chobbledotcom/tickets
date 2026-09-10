import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  PRICE_TYPE_BASE,
  PRICE_TYPE_DAY_COUNT,
  PRICE_TYPE_GROUP,
  PRICE_TYPE_GROUP_DAY,
} from "#db/price-types.ts";
import { unique } from "#fp";

/** The stored `price_type` vocabulary — every dimension key the
 *  `listing_prices` table carries, locked to its literal value because rows
 *  already in the database answer to these exact words. */
describe("price types", () => {
  test("every dimension key equals its stored literal", () => {
    expect(PRICE_TYPE_BASE).toBe("base");
    expect(PRICE_TYPE_DAY_COUNT).toBe("day_count");
    expect(PRICE_TYPE_GROUP).toBe("group");
    expect(PRICE_TYPE_GROUP_DAY).toBe("group_day");
  });

  test("no two dimensions share one key", () => {
    expect(
      unique([
        PRICE_TYPE_BASE,
        PRICE_TYPE_DAY_COUNT,
        PRICE_TYPE_GROUP,
        PRICE_TYPE_GROUP_DAY,
      ]),
    ).toHaveLength(4);
  });
});
