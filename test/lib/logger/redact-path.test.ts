import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { redactPath } from "#shared/logger.ts";

describe("redactPath", () => {
  test("redacts ticket slugs", () => {
    expect(redactPath("/ticket/summer-concert-2024")).toBe(
      "/ticket/[redacted]",
    );
  });

  test("redacts simple ticket slugs", () => {
    expect(redactPath("/ticket/abc")).toBe("/ticket/[redacted]");
  });

  test("preserves /ticket without slug", () => {
    expect(redactPath("/ticket")).toBe("/ticket");
  });

  test("redacts numeric IDs in admin paths", () => {
    expect(redactPath("/admin/events/123")).toBe("/admin/events/[id]");
  });

  test("redacts multiple numeric IDs", () => {
    expect(redactPath("/admin/events/123/attendees/456")).toBe(
      "/admin/events/[id]/attendees/[id]",
    );
  });

  test("preserves paths without dynamic segments", () => {
    expect(redactPath("/admin")).toBe("/admin");
    expect(redactPath("/admin/events")).toBe("/admin/events");
    expect(redactPath("/setup")).toBe("/setup");
    expect(redactPath("/")).toBe("/");
  });

  test("preserves payment paths", () => {
    expect(redactPath("/payment/success")).toBe("/payment/success");
    expect(redactPath("/payment/webhook")).toBe("/payment/webhook");
  });

  test("redacts device ID in wallet webservice device paths", () => {
    expect(redactPath("/v1/devices/abc123/registrations/pass.com.test")).toBe(
      "/v1/devices/[redacted]/registrations/pass.com.test",
    );
  });

  test("redacts token in wallet webservice registration paths", () => {
    expect(
      redactPath("/v1/devices/abc123/registrations/pass.com.test/my-token"),
    ).toBe("/v1/devices/[redacted]/registrations/pass.com.test/[redacted]");
  });

  test("redacts token in wallet webservice pass paths", () => {
    expect(redactPath("/v1/passes/pass.com.test/my-token")).toBe(
      "/v1/passes/pass.com.test/[redacted]",
    );
  });

  test("redacts token in wallet download paths", () => {
    expect(redactPath("/wallet/abc123.pkpass")).toBe("/wallet/[redacted]");
  });

  test("redacts token in checkin paths", () => {
    expect(redactPath("/checkin/abc123")).toBe("/checkin/[redacted]");
  });

  test("handles trailing slashes with IDs", () => {
    expect(redactPath("/admin/events/123/")).toBe("/admin/events/[id]/");
  });
});
