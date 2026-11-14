import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("Admin API - Site pages - taken slug", { db: true }, () => {
  test("a create refuses a slug a listing owns with the form's message", async () => {
    const listing = await createTestListing({ name: "Kayak" });
    await assertJson(
      apiRequest("/api/admin/site-pages", {
        body: { name: "Kayak page", slug: listing.slug },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toBe(
          "That slug is already in use by a listing, group, or page.",
        );
      },
    );
  });
});
