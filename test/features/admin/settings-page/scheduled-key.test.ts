import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  SCHEDULED_OWNER_ENV,
  TEST_SCHEDULED_KEY,
} from "#test-utils/scheduled.ts";
import { adminGet, createTestManagerSession } from "#test-utils/session.ts";

describeWithEnv(
  "scheduled key owner settings",
  { db: true, env: SCHEDULED_OWNER_ENV },
  () => {
    test("shows the local active key on the owner advanced page", async () => {
      const response = await adminGet("/admin/settings-advanced");

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toContain(TEST_SCHEDULED_KEY);
    });

    test("does not show the local key to a manager", async () => {
      const managerCookie = await createTestManagerSession();
      const response = await handleRequest(
        mockRequest("/admin/settings-advanced", {
          headers: { cookie: managerCookie },
        }),
      );

      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(TEST_SCHEDULED_KEY);
    });
  },
);
