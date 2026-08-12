import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv("Admin bulk actions landing page", { db: true }, () => {
  describe("GET /admin/groups/:id/bulk-actions", () => {
    test("returns 404 for a non-existent group", async () => {
      const response = await adminGet("/admin/groups/999999/bulk-actions");
      expect(response.status).toBe(404);
    });

    test("redirects to login when unauthenticated", async () => {
      const response = await handleRequest(
        mockRequest("/admin/groups/1/bulk-actions"),
      );
      expect(response.status).toBe(302);
    });
  });
});
