import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

const settingsRoutes: ReadonlyArray<readonly [string, string]> = [
  ["GET", "/admin/features/example"],
  ["GET", "/admin/listing-defaults"],
  ["GET", "/admin/settings"],
  ["GET", "/admin/settings-advanced"],
  ["POST", "/admin/features/example"],
  ["POST", "/admin/listing-defaults"],
  ["POST", "/admin/settings"],
  ["POST", "/admin/settings/address-lookup"],
  ["POST", "/admin/settings/apple-wallet"],
  ["POST", "/admin/settings/attendee-column-order"],
  ["POST", "/admin/settings/booking-fee"],
  ["POST", "/admin/settings/business-email"],
  ["POST", "/admin/settings/calendar-feeds"],
  ["POST", "/admin/settings/custom-css"],
  ["POST", "/admin/settings/custom-domain"],
  ["POST", "/admin/settings/custom-domain/validate"],
  ["POST", "/admin/settings/email"],
  ["POST", "/admin/settings/email-templates/admin"],
  ["POST", "/admin/settings/email-templates/confirmation"],
  ["POST", "/admin/settings/email-templates/preview"],
  ["POST", "/admin/settings/email/test"],
  ["POST", "/admin/settings/embed-hosts"],
  ["POST", "/admin/settings/external-order"],
  ["POST", "/admin/settings/google-wallet"],
  ["POST", "/admin/settings/header-image"],
  ["POST", "/admin/settings/header-image/delete"],
  ["POST", "/admin/settings/host-subdomain"],
  ["POST", "/admin/settings/listing-column-order"],
  ["POST", "/admin/settings/payment-provider"],
  ["POST", "/admin/settings/payment-provider-recovery"],
  ["POST", "/admin/settings/reset-database"],
  ["POST", "/admin/settings/show-public-api"],
  ["POST", "/admin/settings/sms-gateway"],
  ["POST", "/admin/settings/square"],
  ["POST", "/admin/settings/square-webhook"],
  ["POST", "/admin/settings/square/test"],
  ["POST", "/admin/settings/stripe"],
  ["POST", "/admin/settings/stripe/test"],
  ["POST", "/admin/settings/sumup"],
  ["POST", "/admin/settings/sumup/test"],
  ["POST", "/admin/settings/superuser"],
  ["POST", "/admin/settings/terms"],
  ["POST", "/admin/settings/theme"],
];

describeWithEnv("admin settings routes", { db: true }, () => {
  test("dispatches every static settings route", async () => {
    const staticRoutes = settingsRoutes.filter(
      ([, path]) => !path.startsWith("/admin/features/"),
    );
    for (const [method, path] of staticRoutes) {
      const response =
        method === "GET"
          ? await adminGet(path)
          : (await adminFormPost(path)).response;
      expect(response.status).not.toBe(404);
    }
  });

  test("every settings route rejects an unauthenticated request", async () => {
    const statuses = await Promise.all(
      settingsRoutes.map(
        async ([method, path]) =>
          (await handleRequest(mockRequest(path, { method }))).status,
      ),
    );

    expect(statuses).toEqual(
      settingsRoutes.map(([method]) => (method === "GET" ? 302 : 400)),
    );
  });
});
