import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import {
  createListing,
  saveListingEdit,
  tryCreateListing,
  updateListing,
} from "#test/features/admin/listings-form/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  featureSetting,
  setupStripe,
  withSetting,
} from "#test-utils/settings.ts";

const MONTHLY = {
  recurringInterval: "month",
  recurringPrice: "5.00",
  unitPrice: "10.00",
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
      expect([row.recurringPrice, row.recurringInterval]).toEqual([
        500,
        "month",
      ]);
    }));

  test("clears the plan when the operator chooses Never", () =>
    whileOffered(async () => {
      const row = await createListing(MONTHLY);
      const cleared = await updateListing(row.id, {
        recurringInterval: "",
        recurringPrice: "",
        unitPrice: "10.00",
      });
      expect([cleared.recurringPrice, cleared.recurringInterval]).toEqual([
        0,
        "",
      ]);
    }));

  test("refuses the plan boxes while the feature is off", async () => {
    await setupStripe();
    expect(await tryCreateListing({ ...MONTHLY, name: "Feature off" })).toEqual(
      { error: t("fields.validation.unshown_field"), ok: false },
    );
  });

  test("refuses a plan while Stripe does not take payments", () =>
    withSetting(featureSetting("subscriptions"), async () => {
      await expect(createListing(MONTHLY)).rejects.toThrow(
        `create failed: ${t("error.recurring_needs_stripe")}`,
      );
    }));

  test("keeps the stored plan when a save does not offer the boxes", async () => {
    let id = 0;
    await whileOffered(async () => {
      id = (await createListing(MONTHLY)).id;
    });
    const saved = await updateListing(id, { unitPrice: "12.00" });
    expect(saved.unitPrice).toBe(1200);
    expect([saved.recurringPrice, saved.recurringInterval]).toEqual([
      500,
      "month",
    ]);
  });

  test("lets the owner clear the plan after switching away from Stripe", () =>
    whileOffered(async () => {
      const row = await createListing(MONTHLY);
      await settings.update.setPaymentProviderNone();
      expect(
        await saveListingEdit(row.id, { ...MONTHLY, unitPrice: "12.00" }),
      ).toEqual({ error: t("error.recurring_needs_stripe"), ok: false });
      const cleared = await updateListing(row.id, {
        recurringInterval: "",
        recurringPrice: "",
        unitPrice: "0",
      });
      expect([
        cleared.unitPrice,
        cleared.recurringPrice,
        cleared.recurringInterval,
      ]).toEqual([0, 0, ""]);
    }));

  test("refuses a new listing with a recurring price and no frequency", () =>
    whileOffered(async () => {
      await expect(
        createListing({ ...MONTHLY, recurringInterval: "" }),
      ).rejects.toThrow(
        `create failed: ${t("error.recurring_interval_required")}`,
      );
    }));

  test("refuses an edit that keeps a recurring price and chooses Never", () =>
    whileOffered(async () => {
      const row = await createListing(MONTHLY);
      expect(
        await saveListingEdit(row.id, { ...MONTHLY, recurringInterval: "" }),
      ).toEqual({ error: t("error.recurring_interval_required"), ok: false });
    }));
});
