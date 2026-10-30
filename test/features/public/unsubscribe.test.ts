import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

describeWithEnv(
  "features > public unsubscribe",
  { db: true, encryptionKey: true },
  () => {
    test("resubscribing returns to the link's own page path", async () => {
      // The token is verified by signature, so one minted in this test's
      // request context is valid for the POST's own context.
      const csrf = await withRequestContext(signCsrfToken);

      const response = await awaitTestRequest("/unsubscribe", {
        data: {
          action: "resubscribe",
          csrf_token: csrf,
          email: "abc123hash",
        },
        method: "POST",
      });

      expect(response.status).toBe(302);

      // The redirect carries the flash suffix; the page path leads it.
      const location = response.headers.get("location") ?? "";
      assertStringIncludes(location, "/unsubscribe?email=abc123hash");
    });
  },
);
