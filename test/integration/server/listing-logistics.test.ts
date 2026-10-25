import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminGet } from "#test-utils/session.ts";
import { featureSetting } from "#test-utils/settings.ts";

describeWithEnv("server (listing logistics field)", { db: true }, () => {
  test("renders the logistics field and stores it when logistics is on", async () => {
    settings.setForTest(featureSetting("logistics"));
    const listing = await createTestListing({ usesLogistics: true });
    const stored = await getListingWithCount(listing.id);
    expect(stored!.uses_logistics).toBe(true);

    const response = await adminGet(`/admin/listing/${listing.id}/edit`);
    const html = await response.text();
    assertStringIncludes(html, 'name="uses_logistics"');
    assertStringIncludes(html, "Needs logistics");
  });

  test("the new and duplicate forms include the logistics field", async () => {
    settings.setForTest(featureSetting("logistics"));
    const listing = await createTestListing({ name: "Original" });

    const newForm = await adminGet("/admin/listing/new?template=custom");
    assertStringIncludes(await newForm.text(), 'name="uses_logistics"');

    const dupForm = await adminGet(`/admin/listing/${listing.id}/duplicate`);
    assertStringIncludes(await dupForm.text(), 'name="uses_logistics"');
  });

  test("the new form omits the logistics field when logistics is off", async () => {
    settings.setForTest(featureSetting());
    const newForm = await adminGet("/admin/listing/new?template=custom");
    assert(!(await newForm.text()).includes('name="uses_logistics"'));
  });

  test("ignores the Delivered field when logistics is off", async () => {
    settings.setForTest(featureSetting());
    // The form still submits delivered=1, but the gate forces it false.
    const listing = await createTestListing({ usesLogistics: true });
    const stored = await getListingWithCount(listing.id);
    expect(stored!.uses_logistics).toBe(false);

    const response = await adminGet(`/admin/listing/${listing.id}/edit`);
    const html = await response.text();
    assert(!html.includes('name="uses_logistics"'));
  });
});
