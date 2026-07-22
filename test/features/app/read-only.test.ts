import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readOnlyBlock } from "#routes/app/read-only.ts";

describe("read-only request guard", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    test(`blocks ${method} API requests as API errors`, () => {
      expect(readOnlyBlock("/api/admin/listings/1", method)).toBe("api");
    });
  }

  test("allows API reads", () => {
    expect(readOnlyBlock("/api/admin/listings", "GET")).toBeNull();
  });

  test("redirects admin create, edit, and delete pages", () => {
    for (const path of [
      "/admin/listing/new",
      "/admin/listing/42/edit",
      "/admin/modifiers/42/delete",
    ]) {
      expect(readOnlyBlock(path, "GET")).toBe("page");
    }
  });

  test("allows ordinary admin GET pages", () => {
    expect(readOnlyBlock("/admin/listings", "GET")).toBeNull();
  });

  test("allows only the admin operations that must work in read-only mode", () => {
    expect(readOnlyBlock("/admin", "POST")).toBe("page");
    expect(readOnlyBlock("/admin/settings/email", "POST")).toBe("page");
    for (const path of [
      "/admin/attendees/99/refresh-payment",
      "/admin/backup/create",
      "/admin/debug/sentry",
      "/admin/deliveries/mark",
      "/admin/listing/42/scan",
      "/admin/listing/42/attendee/99/checkin",
      "/admin/login",
      "/admin/logout",
      "/admin/support",
    ]) {
      expect(readOnlyBlock(path, "POST"), path).toBeNull();
    }
    expect(readOnlyBlock("/admin/logout", "PUT")).toBe("page");
  });

  test("allows public operations that must continue in read-only mode", () => {
    const cases: [string, string][] = [
      ["/renew", "POST"],
      ["/pay/token", "POST"],
      ["/payment/webhook", "POST"],
      ["/v1/devices/device/registrations/pass/token", "DELETE"],
      ["/sms/webhook", "POST"],
      ["/join/code", "POST"],
      ["/instance/site-credentials", "POST"],
      ["/checkin/one+two", "POST"],
    ];
    for (const [path, method] of cases) {
      expect(readOnlyBlock(path, method)).toBeNull();
    }
  });

  test("blocks every other public write by default", () => {
    expect(readOnlyBlock("/scheduled", "POST")).toBe("page");
    expect(readOnlyBlock("/ticket/listing", "POST")).toBe("page");
    expect(readOnlyBlock("/read-only", "POST")).toBe("page");
    expect(readOnlyBlock("/unknown", "DELETE")).toBe("page");
  });

  test("allows non-mutating public methods", () => {
    expect(readOnlyBlock("/", "GET")).toBeNull();
    expect(readOnlyBlock("/read-only", "HEAD")).toBeNull();
    expect(readOnlyBlock("/caldav", "PROPFIND")).toBeNull();
  });
});
