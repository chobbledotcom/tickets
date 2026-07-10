// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setTestEnv } from "#test-utils/env.ts";
import { awaitTestRequest, mockRequest } from "#test-utils/mocks.ts";

// jscpd:ignore-end

describeWithEnv("server public > health", { db: true, triggers: true }, () => {
  describe("GET /health", () => {
    test("returns a plain liveness reply by default", async () => {
      const response = await handleRequest(mockRequest("/health"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toBe("Up :)");
    });

    test("returns build diagnostics when the request carries the debug key", async () => {
      const restore = setTestEnv({ DEBUG_KEY: "s3cret-diag-key" });
      try {
        await assertJson(
          handleRequest(
            mockRequest("/health", {
              headers: { "x-debug-key": "s3cret-diag-key" },
            }),
          ),
          200,
          (json) => {
            // The dynamic, meaningful field: a parseable server timestamp.
            expect(typeof json.serverTime).toBe("string");
            expect(Number.isNaN(Date.parse(json.serverTime))).toBe(false);
            // Build markers are present (empty strings in a dev/test build).
            expect(json).toHaveProperty("commit");
            expect(json).toHaveProperty("buildTimestamp");
            // Never leaks the liveness text into the diagnostics payload.
            expect(json).not.toHaveProperty("status");
          },
        );
      } finally {
        restore();
      }
    });

    test("ignores a wrong debug key and stays on plain liveness", async () => {
      const restore = setTestEnv({ DEBUG_KEY: "s3cret-diag-key" });
      try {
        const response = await handleRequest(
          mockRequest("/health", { headers: { "x-debug-key": "wrong" } }),
        );
        expect(await response.text()).toBe("Up :)");
      } finally {
        restore();
      }
    });

    test("ignores the debug header when DEBUG_KEY is unset", async () => {
      // Without DEBUG_KEY configured, no header can unlock diagnostics.
      const response = await handleRequest(
        mockRequest("/health", { headers: { "x-debug-key": "anything" } }),
      );
      expect(await response.text()).toBe("Up :)");
    });

    test("returns 404 for non-GET requests to /health", async () => {
      const response = await awaitTestRequest("/health", {
        data: {},
        method: "POST",
      });
      expect(response.status).toBe(404);
    });
  });
});
