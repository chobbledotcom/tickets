import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  collectFeaturePaths,
  parseSpecOwners,
  readSpecCatalog,
} from "#scripts/specs/catalog.ts";

const FEATURE_PATH = "specs/payments/capacity-after-payment.feature";

describe("Cucumber story catalog", () => {
  test("reads every story from the repository catalog", async () => {
    expect((await readSpecCatalog()).stories.map(({ id }) => id)).toEqual([
      "attendees.checking-people-in-at-the-door",
      "attendees.downloading-the-attendee-list",
      "attendees.editing-and-moving",
      "attendees.merging-duplicate-bookings",
      "attendees.no-quantity-tickets",
      "attendees.removing-one-part-of-an-order",
      "attendees.the-record-kept-about-someone",
      "bookings.add-ons-sold-on-their-own",
      "bookings.adding-a-booking-by-hand",
      "bookings.backup-and-restore",
      "bookings.book-through-the-site",
      "bookings.booking-several-days",
      "bookings.booking-through-the-api",
      "bookings.changes-after-people-have-booked",
      "bookings.changing-how-long-a-stay-lasts",
      "bookings.day-limits-shared-across-listings",
      "bookings.ordering-several-things-at-once",
      "bookings.volunteer-sign-up",
      "payments.capacity-after-payment",
      "payments.correcting-the-books",
      "payments.free-bookings",
      "payments.income-figures-explained",
      "payments.one-payment-many-listings",
      "payments.owner-payment-cases",
      "payments.paying-a-deposit",
      "payments.paying-for-a-mixed-order",
      "payments.paying-more-than-the-asking-price",
      "payments.provider-choice",
      "payments.refunding-a-booking",
      "payments.refunding-everyone-at-once",
      "payments.repeated-money-actions",
      "payments.what-a-paid-booking-earned",
      "servicing.hold-and-cost",
    ]);
  });

  test("reads one exact Feature", async () => {
    expect(
      (await readSpecCatalog([FEATURE_PATH])).stories.map(({ id }) => id),
    ).toEqual(["payments.capacity-after-payment"]);
  });

  test("sorts and removes duplicate Feature paths", async () => {
    const paths = await collectFeaturePaths([FEATURE_PATH, FEATURE_PATH]);
    expect(paths).toHaveLength(1);
    const path = paths[0];
    if (path === undefined) throw new Error("Expected one Feature path");
    expect(path.endsWith(FEATURE_PATH)).toBe(true);
  });

  test("rejects a requested path with no Features", async () => {
    expect(await collectFeaturePaths(["specs/owners.json"])).toEqual([]);
    await expect(readSpecCatalog(["specs/owners.json"])).rejects.toThrow(
      "No Cucumber Feature files found",
    );
  });

  test("validates the owner registry at its JSON boundary", () => {
    expect(parseSpecOwners({ owners: ["payments"] })).toEqual(["payments"]);
    for (const invalid of [
      {},
      { owners: [] },
      { owners: [""] },
      { owners: ["payments", "payments"] },
      { owners: ["   "] },
      { extra: true, owners: ["payments"] },
      null,
    ]) {
      expect(() => parseSpecOwners(invalid)).toThrow();
    }
  });
});
