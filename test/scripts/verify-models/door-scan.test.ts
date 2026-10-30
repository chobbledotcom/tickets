/** The door scan checker data: the production decision function supplies
 *  every admission fact, and the negative control keeps the no-over-
 *  admission verdict honest. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  admitFacts,
  corruptDoorScanData,
  corruptOneAdmission,
  doorScanModelData,
  representatives,
} from "#scripts/verify-models/door-scan.ts";
import { requireValue } from "#shared/required-value.ts";
import { records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

/** The quantity each representative listing books. The derived facts and
 *  the checker's quantity constants must both respect these. */
const quantityOf: Record<string, number> = Object.fromEntries(
  representatives.map((representative) => [
    representative.name,
    representative.quantity,
  ]),
);

/** The fact one scan derives on one listing, with the common flags empty. */
const factOf = (
  listing: string,
  before: number,
  after: number,
  extra: Record<string, string | boolean | number> = {},
): Record<string, string | boolean | number> => ({
  after,
  before,
  idVerified: false,
  listing,
  nonTransferable: false,
  purchaseOnly: false,
  refunded: false,
  ...extra,
});

describe("door scan checker data", () => {
  test("records the one-at-a-time walk on a three-place party", async () => {
    const data = await doorScanModelData();
    const facts = records(data, "AdmitFacts");
    expect(facts).toContainEqual(factOf("one", 0, 1));
    expect(facts).toContainEqual(factOf("one", 1, 2));
    expect(facts).toContainEqual(factOf("one", 2, 3));
  });

  test("records the full pick and caps an over-pick at what remains", async () => {
    const data = await doorScanModelData();
    const facts = records(data, "AdmitFacts");
    expect(facts).toContainEqual(factOf("one", 0, 3));
    expect(facts).toContainEqual(factOf("one", 2, 3));
  });

  test("records that a line owing more than one place asks first", async () => {
    const data = await doorScanModelData();
    const facts = records(data, "AdmitFacts");
    expect(facts).toContainEqual(factOf("one", 0, 0));
  });

  test("records that a listing with every place in admits nothing", async () => {
    const data = await doorScanModelData();
    const facts = records(data, "AdmitFacts");
    expect(facts).toContainEqual(factOf("one", 3, 3));
    expect(facts).toContainEqual(factOf("two", 1, 1));
  });

  test("records each gate: refunded, no-check-in and the ID hold", async () => {
    const data = await doorScanModelData();
    const facts = records(data, "AdmitFacts");
    expect(facts).toContainEqual(factOf("one", 0, 0, { refunded: true }));
    expect(facts).toContainEqual(factOf("one", 0, 0, { purchaseOnly: true }));
    expect(facts).toContainEqual(
      factOf("one", 0, 0, { idVerified: false, nonTransferable: true }),
    );
    expect(facts).toContainEqual(
      factOf("one", 0, 1, { idVerified: true, nonTransferable: true }),
    );
  });

  test("records the single-ticket listing's admit and the group box", async () => {
    const data = await doorScanModelData();
    const facts = records(data, "AdmitFacts");
    expect(facts).toContainEqual(factOf("two", 0, 1));
    expect(facts).toHaveLength(12);
  });

  test("every derived admission stays at or under the listing's quantity", () => {
    for (const fact of admitFacts()) {
      const quantity = requireValue(
        quantityOf[fact.listing],
        `Missing representative quantity for ${fact.listing}`,
      );
      expect(fact.after).toBeLessThanOrEqual(quantity);
      expect(fact.after).toBeGreaterThanOrEqual(fact.before);
      expect(fact.before).toBeGreaterThanOrEqual(0);
    }
  });

  test("a refunded, no-check-in or unverified hold admits nothing", () => {
    for (const fact of admitFacts()) {
      if (fact.refunded || fact.purchaseOnly)
        expect(fact.after).toBe(fact.before);
      if (fact.nonTransferable && !fact.idVerified) {
        expect(fact.after).toBe(fact.before);
      }
    }
  });

  test("the corrupted module admits past the listing's quantity", async () => {
    const data = await corruptDoorScanData();
    expect(records(data, "AdmitFacts")).toContainEqual(factOf("one", 2, 4));
  });

  test("corrupting one over-pick makes an admission past the quantity", () => {
    const corrupted = corruptOneAdmission();
    const unsafe = corrupted.filter((fact) => fact.after > 3);
    expect(unsafe).toHaveLength(
      admitFacts().filter(
        (fact) =>
          fact.listing === "one" && fact.before === 2 && fact.after === 3,
      ).length,
    );
    expect(corrupted).toContainEqual(factOf("one", 2, 4));
    for (const fact of unsafe) {
      expect(fact.before).toBe(2);
      expect(fact.after).toBe(4);
    }
  });
});
