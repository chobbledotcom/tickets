import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  checkScheduledAccess,
  scheduledResponse,
} from "#shared/scheduled-access.ts";
import {
  scheduledAuthorization,
  TEST_SCHEDULED_KEY,
  TEST_SCHEDULED_NEXT_KEY,
} from "#test-utils/scheduled.ts";

const request = (
  method: string,
  authorization?: string,
  path = "/scheduled",
): Request =>
  new Request(`https://example.test${path}`, {
    ...(authorization ? { headers: { authorization } } : {}),
    method,
  });

describe("scheduled access", () => {
  test("leaves every other path to the normal app", () => {
    expect(
      checkScheduledAccess(
        request("GET", undefined, "/health"),
        undefined,
        undefined,
      ),
    ).toEqual({ kind: "not_scheduled" });
  });

  test("hides every non-POST method", () => {
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(
        checkScheduledAccess(
          request(method, scheduledAuthorization().authorization),
          TEST_SCHEDULED_KEY,
          TEST_SCHEDULED_NEXT_KEY,
        ),
      ).toEqual({ kind: "rejected", status: 404 });
    }
  });

  test("hides POST when the active key is unset", () => {
    expect(
      checkScheduledAccess(
        request("POST", scheduledAuthorization().authorization),
        undefined,
        TEST_SCHEDULED_NEXT_KEY,
      ),
    ).toEqual({ kind: "rejected", status: 404 });
  });

  test("rejects missing, malformed, and wrong bearer values", () => {
    for (const authorization of [
      undefined,
      `Basic ${TEST_SCHEDULED_KEY}`,
      "Bearer",
      "Bearer mutated",
      "Bearer wrong",
    ]) {
      expect(
        checkScheduledAccess(
          request("POST", authorization),
          TEST_SCHEDULED_KEY,
          TEST_SCHEDULED_NEXT_KEY,
        ),
      ).toEqual({ kind: "rejected", status: 401 });
    }
  });

  test("accepts either configured slot", () => {
    for (const key of [TEST_SCHEDULED_KEY, TEST_SCHEDULED_NEXT_KEY]) {
      expect(
        checkScheduledAccess(
          request("POST", scheduledAuthorization(key).authorization),
          TEST_SCHEDULED_KEY,
          TEST_SCHEDULED_NEXT_KEY,
        ),
      ).toEqual({ kind: "authorized" });
    }
  });

  test("does not invent a next key when that slot is unset", () => {
    expect(
      checkScheduledAccess(
        request("POST", "Bearer mutated"),
        TEST_SCHEDULED_KEY,
        undefined,
      ),
    ).toEqual({ kind: "rejected", status: 401 });
  });

  test("returns an empty no-store response for every outcome", async () => {
    for (const status of [204, 401, 404, 503] as const) {
      const response = scheduledResponse(status);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
  });

  test("adds a bearer challenge only to an unauthorized response", () => {
    expect(scheduledResponse(401).headers.get("www-authenticate")).toBe(
      "Bearer",
    );
    for (const status of [204, 404, 503] as const) {
      expect(
        scheduledResponse(status).headers.get("www-authenticate"),
      ).toBeNull();
    }
  });
});
