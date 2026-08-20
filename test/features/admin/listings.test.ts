/**
 * The listings area's route table: the tabbed listing page it binds, the image
 * routes it wires, and the attendee export. The handlers themselves live in
 * the per-feature modules beside it, each with its own suite.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("the listings routes", { db: true }, () => {
  test("serves one listing's page and its named tabs", async () => {
    const listing = await createTestListing({ name: "Bouncy Castle" });

    const page = await adminGet(`/admin/listing/${listing.id}`);
    const tab = await adminGet(`/admin/listing/${listing.id}/attendees`);

    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Bouncy Castle");
    expect(tab.status).toBe(200);
  });

  test("answers 404 for a listing that is not there", async () => {
    expect((await adminGet("/admin/listing/99999")).status).toBe(404);
  });

  test("sends an image save back to the edit tab with storage off", async () => {
    // Pictures need a storage zone. With none configured the save cannot
    // happen, and the operator returns to the form they came from.
    const listing = await createTestListing({ name: "No Pictures" });

    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/images`,
      {},
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      `/admin/listing/${listing.id}/edit`,
    );
  });

  test("exports the listing's attendees as a CSV download", async () => {
    const listing = await createTestListing({ name: "Exported" });

    const response = await adminGet(
      `/admin/listing/${listing.id}/attendees.csv`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
  });
});
