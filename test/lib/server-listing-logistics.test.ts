import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { adminGet, createTestListing, describeWithEnv } from "#test-utils";

describeWithEnv("server (listing logistics field)", { db: true }, () => {
  test("renders the logistics field and stores it when logistics is on", async () => {
    settings.setForTest({ has_logistics: true });
    const listing = await createTestListing({ usesLogistics: true });
    const stored = await getListingWithCount(listing.id);
    expect(stored!.uses_logistics).toBe(true);

    const response = await adminGet(`/admin/listing/${listing.id}/edit`);
    const html = await response.text();
    expect(html).toContain('name="uses_logistics"');
    expect(html).toContain("Needs logistics");
  });

  test("the new and duplicate forms include the logistics field", async () => {
    settings.setForTest({ has_logistics: true });
    const listing = await createTestListing({ name: "Original" });

    const newForm = await adminGet("/admin/listing/new?template=custom");
    expect(await newForm.text()).toContain('name="uses_logistics"');

    const dupForm = await adminGet(`/admin/listing/${listing.id}/duplicate`);
    expect(await dupForm.text()).toContain('name="uses_logistics"');
  });

  test("the new form omits the logistics field when logistics is off", async () => {
    settings.setForTest({ has_logistics: false });
    const newForm = await adminGet("/admin/listing/new?template=custom");
    expect(await newForm.text()).not.toContain('name="uses_logistics"');
  });

  test("ignores the Delivered field when logistics is off", async () => {
    settings.setForTest({ has_logistics: false });
    // The form still submits delivered=1, but the gate forces it false.
    const listing = await createTestListing({ usesLogistics: true });
    const stored = await getListingWithCount(listing.id);
    expect(stored!.uses_logistics).toBe(false);

    const response = await adminGet(`/admin/listing/${listing.id}/edit`);
    const html = await response.text();
    expect(html).not.toContain('name="uses_logistics"');
  });
});
