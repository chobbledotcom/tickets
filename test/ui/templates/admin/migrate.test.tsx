import { assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminMigrateRebuildPaymentsPage } from "#templates/admin/migrate.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

describe("templates > admin migrate rebuild page", () => {
  beforeAll(setupAdminPageTest);

  test("names each row's provider field after its encoded session id", () => {
    const html = adminMigrateRebuildPaymentsPage(OWNER_SESSION, {
      page: [
        {
          alreadyTagged: false,
          paymentSessionId: "cs_live_a&b",
          processedAt: "2026-01-02T03:04:05Z",
          reference: "pi_123",
        },
      ],
      remaining: 1,
    });

    // The session id is URI-encoded, so a `&` or `=` in it cannot read as
    // another row's field or as a second form parameter.
    assertStringIncludes(html, 'name="provider_cs_live_a%26b"');
  });
});
