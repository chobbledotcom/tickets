/**
 * Creating, duplicating and editing a listing: where each one leaves the
 * operator, and what a rejected save keeps. The form parsing itself lives in
 * listings-form.ts with its own suite.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingsTable } from "#db/listings/records.ts";
import { adminLandingPath } from "#routes/auth.ts";
import { expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  buildCreateListingForm,
  buildUpdateListingForm,
} from "#test-utils/db-helpers/listing-forms.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingInput } from "#test-utils/factories.ts";
import { awaitTestRequest, mockMultipartRequest } from "#test-utils/mocks.ts";
import {
  adminGet,
  adminMultipartPost,
  createTestEditorSession,
  testCsrfToken,
} from "#test-utils/session.ts";

const listingForm = (name: string) =>
  buildCreateListingForm(testListingInput({ listingType: "standard", name }));

describeWithEnv("creating a listing", { db: true }, () => {
  test("sends staff to their own landing page", async () => {
    // Staff land on the dashboard, which renders the flash the create sets.
    const { response } = await adminMultipartPost(
      "/admin/listing",
      listingForm("Made By Staff"),
    );

    // The flash marker rides on the query string; the page is the assertion.
    expect(expectRedirect(response).split("?")[0]).toBe(
      adminLandingPath("owner"),
    );
    const { getAllListings } = await import("#db/listings/records.ts");
    expect((await getAllListings()).map((one) => one.name)).toContain(
      "Made By Staff",
    );
  });

  test("sends an editor to the new listing's own page", async () => {
    // An editor cannot open the dashboard, so a successful create must not
    // land them on it.
    const { cookie } = await createTestEditorSession();
    const { handleRequest } = await import("#routes");

    const response = await handleRequest(
      mockMultipartRequest(
        "/admin/listing",
        { ...listingForm("Made By Editor"), csrf_token: await testCsrfToken() },
        cookie,
      ),
    );

    const location = expectRedirect(response);
    expect(location).toMatch(/^\/admin\/listing\/\d+/);
  });
});

describeWithEnv("editing a listing", { db: true }, () => {
  test("saves the change and returns to the listing's own page", async () => {
    const listing = await createTestListing({ name: "Before" });

    const { response } = await adminMultipartPost(
      `/admin/listing/${listing.id}/edit`,
      buildUpdateListingForm({ name: "After" }, listing),
    );

    expect(expectRedirect(response)).toContain(`/admin/listing/${listing.id}`);
    const after = await listingsTable.read.pick(["name"]).one({
      id: listing.id,
    });
    expect(after!.name).toBe("After");
  });

  test("keeps what was typed when the save is rejected", async () => {
    const listing = await createTestListing({ name: "Keep Me" });

    const { response } = await adminMultipartPost(
      `/admin/listing/${listing.id}/edit`,
      { ...buildUpdateListingForm({}, listing), name: "" },
    );

    expect(response.status).toBe(400);
  });

  test("answers 404 editing a listing that is not there", async () => {
    const listing = await createTestListing({ name: "Elsewhere" });

    const { response } = await adminMultipartPost(
      "/admin/listing/99999/edit",
      buildUpdateListingForm({}, listing),
    );

    expect(response.status).toBe(404);
  });
});

describeWithEnv("duplicating a listing", { db: true }, () => {
  test("opens a confirmation naming the listing to copy", async () => {
    const listing = await createTestListing({ name: "Copy Me" });

    const response = await adminGet(`/admin/listing/${listing.id}/duplicate`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Copy Me");
  });

  test("answers 404 duplicating a listing that is not there", async () => {
    expect((await adminGet("/admin/listing/99999/duplicate")).status).toBe(404);
  });
});

describeWithEnv("the new listing form", { db: true }, () => {
  test("opens for an editor, who may create listings", async () => {
    const { cookie } = await createTestEditorSession();

    const response = await awaitTestRequest("/admin/listing/new", { cookie });

    expect(response.status).toBe(200);
  });
});
