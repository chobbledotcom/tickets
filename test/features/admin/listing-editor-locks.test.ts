/** The listing form reads only the boxes its page shows. A form that sends a
 *  field box the writer's page hides is refused, whoever crafted it. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getStoredListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import { buildUpdateListingResource } from "#routes/admin/listings-form.ts";
import { listingFormView } from "#templates/fields/listing.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { baseListingForm } from "#test-utils/factories.ts";
import { testFormParams } from "#test-utils/form-values.ts";
import type { AdminLevel } from "#types";

/** Read one edit form of a new stored listing as a writer of this level. */
const readEdit = async (
  adminLevel: AdminLevel,
  extra: Record<string, string>,
) => {
  const name = `Hall ${adminLevel} ${Object.keys(extra).join(" ")}`;
  const listing = await createTestListing({ name });
  const stored = (await getStoredListingWithCount(listing.id))!;
  const form = testFormParams({
    ...baseListingForm,
    maxAttendees: "50",
    maxQuantity: "1",
    name,
    slug: stored.slug,
    unitPrice: "0",
    ...extra,
  });
  return buildUpdateListingResource(
    stored,
    listingFormView(adminLevel),
  ).parseInput(form);
};

describeWithEnv("listing editor field locks", { db: true }, () => {
  test("an editor's form that sends the webhook or the bookable state is refused", async () => {
    const refusal = { error: t("fields.validation.unshown_field"), ok: false };
    expect([
      await readEdit("editor", { webhookUrl: "https://attacker.example" }),
      await readEdit("editor", { active: "0" }),
      await readEdit("editor", { useDefaults: "1" }),
    ]).toEqual([refusal, refusal, refusal]);
  });

  test("an owner's form sets the webhook, and no form ever reads the bookable state", async () => {
    const webhook = await readEdit("owner", {
      webhookUrl: "https://owner.example/hook",
    });
    const active = await readEdit("owner", { active: "0" });
    expect([
      webhook.ok ? webhook.value.webhookUrl : webhook.error,
      active.ok ? "read" : active.error,
    ]).toEqual([
      "https://owner.example/hook",
      t("fields.validation.unshown_field"),
    ]);
  });
});
