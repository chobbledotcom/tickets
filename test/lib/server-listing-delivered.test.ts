import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { adminGet, createTestListing, describeWithEnv } from "#test-utils";

describeWithEnv("server (listing delivered field)", { db: true }, () => {
  test("renders the Delivered field and stores it when delivery is on", async () => {
    settings.setForTest({ has_delivery: true });
    const listing = await createTestListing({ delivered: true });
    const stored = await getListingWithCount(listing.id);
    expect(stored!.delivered).toBe(true);

    const { response } = await adminGet(`/admin/listing/${listing.id}/edit`);
    const html = await response.text();
    expect(html).toContain('name="delivered"');
    expect(html).toContain("Delivered");
  });

  test("the new and duplicate forms include the Delivered field", async () => {
    settings.setForTest({ has_delivery: true });
    const listing = await createTestListing({ name: "Original" });

    const newForm = await adminGet("/admin/listing/new");
    expect(await newForm.response.text()).toContain('name="delivered"');

    const dupForm = await adminGet(`/admin/listing/${listing.id}/duplicate`);
    expect(await dupForm.response.text()).toContain('name="delivered"');
  });

  test("the new form omits the Delivered field when delivery is off", async () => {
    settings.setForTest({ has_delivery: false });
    const newForm = await adminGet("/admin/listing/new");
    expect(await newForm.response.text()).not.toContain('name="delivered"');
  });

  test("ignores the Delivered field when delivery is off", async () => {
    settings.setForTest({ has_delivery: false });
    // The form still submits delivered=1, but the gate forces it false.
    const listing = await createTestListing({ delivered: true });
    const stored = await getListingWithCount(listing.id);
    expect(stored!.delivered).toBe(false);

    const { response } = await adminGet(`/admin/listing/${listing.id}/edit`);
    const html = await response.text();
    expect(html).not.toContain('name="delivered"');
  });
});
