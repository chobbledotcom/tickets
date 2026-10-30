/** The door scan checker data: the production decision function supplies
 *  every admission fact, and the negative controls keep the safety
 *  verdicts honest. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  admitFacts,
  corruptDoorScanData,
  corruptOneAdmission,
  corruptOneFact,
  doorScanModelData,
  refundedAdmissionDoorScanData,
  representatives,
  takeBackDoorScanData,
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
  test("records exactly the facts the scenarios derive", () => {
    expect(admitFacts()).toEqual([
      // A party of three, admitted place by place.
      factOf("one", 0, 1),
      factOf("one", 1, 2),
      factOf("one", 2, 3),
      // A full pick admits the whole party in one scan.
      factOf("one", 0, 3),
      // An over-pick caps at what the listing still owes.
      factOf("one", 2, 3),
      // Two rows of one booking admit against the listing's one count.
      factOf("one", 0, 2),
      // A line owing more than one place asks first, and admits nothing.
      factOf("one", 0, 0),
      // Every place already in admits nothing.
      factOf("one", 3, 3),
      // The gates: a refunded row, an ID hold, a verified hold, and a
      // no-check-in row.
      factOf("one", 0, 0, { refunded: true }),
      factOf("one", 0, 0, { nonTransferable: true }),
      factOf("one", 0, 1, { idVerified: true, nonTransferable: true }),
      factOf("one", 0, 0, { purchaseOnly: true }),
      // The single-ticket listing: admitted, then already in.
      factOf("two", 0, 1),
      factOf("two", 1, 1),
      // Without the box, one picked scan admits the first listing that
      // owes only, and never reaches the next one.
      factOf("one", 0, 1),
      // Under the box, one scan admits every listing that still owes.
      factOf("one", 0, 1),
      factOf("two", 0, 1),
      // The walk lands on the next listing when the first is fully in.
      factOf("two", 0, 1),
    ]);
  });

  test("names the data module and the quantity constants the proof reads", async () => {
    const data = await doorScanModelData();
    expect(data).toContain("MODULE DoorScanData");
    expect(data).toContain("QuantityOne ==");
    expect(data).toContain("QuantityTwo ==");
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

  test("the take-back module reverses one walk step", async () => {
    const data = await takeBackDoorScanData();
    expect(records(data, "AdmitFacts")).toContainEqual(factOf("one", 1, 0));
  });

  test("the refunded module admits a refunded row", async () => {
    const data = await refundedAdmissionDoorScanData();
    expect(records(data, "AdmitFacts")).toContainEqual(
      factOf("one", 0, 1, { refunded: true }),
    );
  });

  test("a control that matches no fact refuses to corrupt", () => {
    expect(() => corruptOneFact(() => false, 0)).toThrow(
      "The corrupted control matches no admission fact.",
    );
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
