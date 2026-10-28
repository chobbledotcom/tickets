import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readOnlyBlock } from "#routes/app/read-only.ts";
import { ADMIN_SURFACE, oneServedPath } from "#shared/admin-surface.ts";

/** The ordinary expired-deadline mode: READ_ONLY_FROM in the past. */
const ordinary = (path: string, method: string): "api" | "page" | null =>
  readOnlyBlock(path, method, false);

/** Update mode: UPDATE_IN_PROGRESS is set. */
const updating = (path: string, method: string): "api" | "page" | null =>
  readOnlyBlock(path, method, true);

describe("read-only request guard", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    test(`blocks ${method} API requests as API errors`, () => {
      expect(ordinary("/api/admin/listings/1", method)).toBe("api");
    });
  }

  test("allows API reads", () => {
    expect(ordinary("/api/admin/listings", "GET")).toBeNull();
  });

  test("redirects admin create, edit, and delete pages", () => {
    for (const path of [
      "/admin/listing/new",
      "/admin/listing/42/edit",
      "/admin/modifiers/42/delete",
    ]) {
      expect(ordinary(path, "GET")).toBe("page");
    }
  });

  test("keeps the GET page of every admin write the mode keeps open", () => {
    // The check-in POST stays open, and the check-in page is the form the
    // operator submits a multi-ticket check-in from. Redirecting that page
    // would keep the operation open while hiding its only form.
    expect(ordinary("/admin/listing/42/attendee/99/checkin", "GET")).toBeNull();
  });

  test("keeps the form page of every declared write the mode keeps open", () => {
    // The whole surface at once: when the mode keeps a write open, the page
    // its GET serves stays open too — the operator submits the operation
    // from that page. The reverse is not required: a write the mode blocks
    // may keep a readable GET (the built-site support message does). A new
    // write declaration lands in this walk automatically.
    for (const destination of Object.values(ADMIN_SURFACE.destinations)) {
      if (destination.intent !== "write-form") continue;
      const path = oneServedPath(destination.pattern);
      if (ordinary(path, "POST") !== null) continue;
      expect(ordinary(path, "GET"), destination.id).toBeNull();
    }
  });

  test("allows ordinary admin GET pages", () => {
    expect(ordinary("/admin/listings", "GET")).toBeNull();
  });

  test("allows only the admin operations that must work in read-only mode", () => {
    expect(ordinary("/admin", "POST")).toBe("page");
    expect(ordinary("/admin/settings/email", "POST")).toBe("page");
    for (const path of [
      "/admin/attendees/99/refresh-payment",
      "/admin/backup/create",
      "/admin/debug/sentry",
      "/admin/deliveries/mark",
      "/admin/listing/42/scan",
      "/admin/listing/42/attendee/99/checkin",
      "/admin/groups/42/scan",
      "/admin/login",
      "/admin/logout",
      "/admin/support",
    ]) {
      expect(ordinary(path, "POST"), path).toBeNull();
    }
    expect(ordinary("/admin/logout", "PUT")).toBe("page");
  });

  test("blocks the group's every-listing door rule save in read-only mode", () => {
    // The scan at the door keeps working; changing the group's stored door
    // preference is a group write, so its edit form is blocked like the
    // group's other writes.
    expect(ordinary("/admin/groups/42/edit", "POST")).toBe("page");
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
      expect(ordinary(path, method)).toBeNull();
    }
  });

  test("blocks every other public write by default", () => {
    expect(ordinary("/scheduled", "POST")).toBe("page");
    expect(ordinary("/ticket/listing", "POST")).toBe("page");
    expect(ordinary("/read-only", "POST")).toBe("page");
    expect(ordinary("/unknown", "DELETE")).toBe("page");
  });

  test("allows non-mutating public methods", () => {
    expect(ordinary("/", "GET")).toBeNull();
    expect(ordinary("/read-only", "HEAD")).toBeNull();
    expect(ordinary("/caldav", "PROPFIND")).toBeNull();
  });
});

describe("read-only request guard in update mode", () => {
  test("blocks the API paths as API errors", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(updating("/api/admin/listings/1", method)).toBe("api");
    }
  });

  test("gives the payment and SMS webhooks the retryable API answer", () => {
    // The providers redeliver a webhook that gets a non-2xx answer, so the
    // update block answers them like an API call, not with the human
    // redirect.
    expect(updating("/payment/webhook", "POST")).toBe("api");
    expect(updating("/sms/webhook", "POST")).toBe("api");
  });

  test("update mode refuses the public writes read-only mode allows", () => {
    // The update's data migration must see a still database, so no safe
    // path stays open.
    const cases: [string, string][] = [
      ["/renew", "POST"],
      ["/pay/token", "POST"],
      ["/v1/devices/device/registrations/pass/token", "DELETE"],
      ["/join/code", "POST"],
      ["/instance/site-credentials", "POST"],
      ["/checkin/one+two", "POST"],
      ["/ticket/listing", "POST"],
    ];
    for (const [path, method] of cases) {
      expect(updating(path, method), path).toBe("page");
    }
  });

  test("keeps the admin signed in and reading pages", () => {
    expect(updating("/admin/listings", "GET")).toBeNull();
    expect(updating("/admin/login", "POST")).toBeNull();
    expect(updating("/admin/logout", "POST")).toBeNull();
  });

  test("update mode refuses the listed admin writes", () => {
    // The migration must see a still database, so even the operations
    // ordinary read-only mode allows stop while an update runs.
    for (const path of [
      "/admin/listing/42/attendee/99/checkin",
      "/admin/listing/42/scan",
      "/admin/deliveries/mark",
      "/admin/backup/create",
    ]) {
      expect(updating(path, "POST"), path).toBe("page");
    }
  });
  test("blocks admin mutations like ordinary read-only mode", () => {
    expect(updating("/admin/listing/42/edit", "GET")).toBe("page");
    expect(updating("/admin/groups/42/edit", "POST")).toBe("page");
  });

  test("allows reads", () => {
    expect(updating("/", "GET")).toBeNull();
    expect(updating("/api/admin/listings", "GET")).toBeNull();
  });
});
