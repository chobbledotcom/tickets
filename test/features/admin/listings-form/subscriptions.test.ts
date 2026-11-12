import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import {
  createListing,
  updateListing,
} from "#test/features/admin/listings-form/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  featureSetting,
  setupStripe,
  withSetting,
} from "#test-utils/settings.ts";

const MONTHLY = {
  recurring_interval: "month",
  recurring_price: "5.00",
  unit_price: "10.00",
};

/** Run `body` while the site offers subscriptions: the feature is on and
 * Stripe takes payments. */
const whileOffered = async (body: () => Promise<void>): Promise<void> => {
  await setupStripe();
  await withSetting(featureSetting("subscriptions"), body);
};

describeWithEnv("listings form subscriptions", { db: true }, () => {
  test("keeps a recurring price and frequency while subscriptions are offered", () =>
    whileOffered(async () => {
      const row = await createListing(MONTHLY);
      expect([row.recurring_price, row.recurring_interval]).toEqual([
        500,
        "month",
      ]);
    }));

  test("clears the plan when the operator chooses Never", () =>
    whileOffered(async () => {
      const row = await createListing(MONTHLY);
      const cleared = await updateListing(row.id, {
        recurring_interval: "",
        recurring_price: "",
        unit_price: "10.00",
      });
      expect([cleared.recurring_price, cleared.recurring_interval]).toEqual([
        0,
        "",
      ]);
    }));

  test("ignores the plan boxes while subscriptions are not offered", async () => {
    await withSetting(featureSetting("subscriptions"), async () => {
      const row = await createListing(MONTHLY);
      expect([row.recurring_price, row.recurring_interval]).toEqual([0, ""]);
    });
    await setupStripe();
    const row = await createListing({ ...MONTHLY, name: "Feature off" });
    expect([row.recurring_price, row.recurring_interval]).toEqual([0, ""]);
  });

  test("keeps the stored plan when a save does not offer the boxes", async () => {
    let id = 0;
    await whileOffered(async () => {
      id = (await createListing(MONTHLY)).id;
    });
    const saved = await updateListing(id, { unit_price: "12.00" });
    expect(saved.unit_price).toBe(1200);
    expect([saved.recurring_price, saved.recurring_interval]).toEqual([
      500,
      "month",
    ]);
  });

  test("validates and preserves the stored plan after switching away from Stripe", () =>
    whileOffered(async () => {
      const row = await createListing(MONTHLY);
      await settings.update.setPaymentProviderNone();
      await expect(updateListing(row.id, { unit_price: "0" })).rejects.toThrow(
        `update failed: ${t("error.recurring_needs_ticket_price")}`,
      );
      const saved = await updateListing(row.id, { unit_price: "12.00" });
      expect([
        saved.unit_price,
        saved.recurring_price,
        saved.recurring_interval,
      ]).toEqual([1200, 500, "month"]);
    }));

  test("refuses a new listing with a recurring price and no frequency", () =>
    whileOffered(async () => {
      await expect(
        createListing({ ...MONTHLY, recurring_interval: "" }),
      ).rejects.toThrow(
        `create failed: ${t("error.recurring_interval_required")}`,
      );
    }));

  test("refuses an edit that keeps a recurring price and chooses Never", () =>
    whileOffered(async () => {
      const row = await createListing(MONTHLY);
      await expect(
        updateListing(row.id, { ...MONTHLY, recurring_interval: "" }),
      ).rejects.toThrow(
        `update failed: ${t("error.recurring_interval_required")}`,
      );
    }));
});
