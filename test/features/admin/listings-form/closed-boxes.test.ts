/** The listing form refuses a box its page hides: a switch the site holds
 *  no defaults for, a webhook in the demo, and a box whose feature is off. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { buildCreateListingResource } from "#routes/admin/listings-form.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { listingFormView } from "#templates/fields/listing.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { featureSetting, withSetting } from "#test-utils/settings.ts";
import { createListing, listingForm, updateListing } from "./helpers.ts";

describeWithEnv("listings form closed boxes", { db: true }, () => {
  test("the use-defaults tick is saved while the site holds defaults, and refused while its box is hidden", async () => {
    const hidden = await buildCreateListingResource(
      listingForm({ use_defaults: "1" }),
      listingFormView("owner"),
    ).create(listingForm({ use_defaults: "1" }));
    await settings.update.listingDefaults({ hidden: true });
    const on = await createListing({ use_defaults: "1" });
    const off = await createListing({ name: "Own values" });
    expect([hidden, on.use_defaults, off.use_defaults]).toEqual([
      { error: t("fields.validation.unshown_field"), ok: false },
      true,
      false,
    ]);
  });

  test("demo mode refuses a webhook address, normal mode keeps it", async () => {
    const hook = "https://example.com/hook";
    const real = await createListing({ webhook_url: hook });
    expect(real.webhook_url).toBe(hook);

    setDemoModeForTest(true);
    try {
      await expect(
        createListing({ name: "Demo listing", webhook_url: hook }),
      ).rejects.toThrow(t("fields.validation.unshown_field"));
    } finally {
      setDemoModeForTest(false);
    }
  });

  test("a builder or logistics box is refused while its feature is off", async () => {
    const refusal = t("fields.validation.unshown_field");
    await expect(createListing({ assign_built_site: "1" })).rejects.toThrow(
      refusal,
    );
    await expect(createListing({ uses_logistics: "" })).rejects.toThrow(
      refusal,
    );
  });

  test("a logistics choice is kept when the feature is on", () =>
    withSetting(featureSetting("logistics"), async () => {
      const on = await createListing({ uses_logistics: "1" });
      expect(on.uses_logistics).toBe(true);
      // An unticked checkbox never reaches the form at all.
      const off = await createListing({ name: "No logistics" });
      expect(off.uses_logistics).toBe(false);
    }));

  test("an edit saved while logistics is off keeps the stored logistics choice", async () => {
    const row = await withSetting(featureSetting("logistics"), () =>
      createListing({ uses_logistics: "1" }),
    );
    const saved = await updateListing(row.id, { name: "Renamed" });
    expect([saved.name, saved.uses_logistics]).toEqual(["Renamed", true]);
  });
});
