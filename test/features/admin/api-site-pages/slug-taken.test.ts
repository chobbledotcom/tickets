import { it as test } from "@std/testing/bdd";
import { expectApiError } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("Admin API - Site pages - taken slug", { db: true }, () => {
  test("a create refuses a slug another page owns with the form's message", async () => {
    const owner = await createTestSitePage("visit", { name: "Visit" });
    await expectApiError(
      apiRequest("/api/admin/site-pages", {
        body: { name: "Second visit", slug: owner.slug },
        method: "POST",
      }),
      400,
      "That slug is already in use by a listing, group, or page.",
    );
  });
});
