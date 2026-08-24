import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { redactPath } from "#shared/redact-path.ts";

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
    expect(redactPath("/admin/listings/123")).toBe("/admin/listings/[id]");
  });

  test("redacts multiple numeric IDs", () => {
    expect(redactPath("/admin/listings/123/attendees/456")).toBe(
      "/admin/listings/[id]/attendees/[id]",
    );
  });

  test("preserves paths without dynamic segments", () => {
    expect(redactPath("/admin")).toBe("/admin");
    expect(redactPath("/admin/listings")).toBe("/admin/listings");
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
    expect(redactPath("/admin/listings/123/")).toBe("/admin/listings/[id]/");
  });

  // Regression: the live ticket route is `/t/:token`, not `/ticket/:slug`.
  // The token is the whole credential for that ticket, and it was reaching the
  // logs and the error reporter in full.
  test("redacts the token on the live ticket route", () => {
    expect(redactPath("/t/9D5F57B232")).toBe("/t/[redacted]");
  });

  test("redacts every token on a multi-ticket URL", () => {
    expect(redactPath("/t/9D5F57B232+A1B2C3D4E5")).toBe("/t/[redacted]");
  });

  test("keeps the bare ticket route, which carries no token", () => {
    expect(redactPath("/t")).toBe("/t");
  });

  test("leaves routes that only start with the same letter alone", () => {
    expect(redactPath("/terms")).toBe("/terms");
  });
});
