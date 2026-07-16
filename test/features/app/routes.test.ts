import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { routeMainApp } from "#routes/app/routes.ts";
import { setAdminFeatureEnabled } from "#shared/db/admin-features.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicApi, enablePublicSite } from "#test-utils/settings.ts";

const route = async (path: string, method = "GET"): Promise<Response> => {
  const response = await routeMainApp({
    method,
    path,
    request: mockRequest(path, { method }),
    server: undefined,
  });
  return response;
};

describeWithEnv("main app router", { db: true }, () => {
  test("returns not found for an unknown prefix", async () => {
    expect((await route("/unknown-path")).status).toBe(404);
  });

  test("returns not found for an inherited object property", async () => {
    expect((await route("/constructor")).status).toBe(404);
  });

  test("redirects a disabled public page to login", async () => {
    const response = await route("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/login");
  });

  test("serves the public home page when enabled", async () => {
    await enablePublicSite();
    expect((await route("/")).status).toBe(200);
  });

  test("serves public listings only at their exact path", async () => {
    await enablePublicSite();

    const response = await route("/listings");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("No listings listed.");
  });

  test("does not serve a public page below its exact path", async () => {
    await enablePublicSite();
    expect((await route("/listings/extra")).status).toBe(404);
  });

  test("turns a null result from a known prefix into not found", async () => {
    expect((await route("/custom.css/extra")).status).toBe(404);
  });

  test("redirects the legacy events path only while the site is public", async () => {
    await enablePublicSite();
    const enabled = await route("/events");
    expect(enabled.status).toBe(302);
    expect(enabled.headers.get("location")).toBe("/listings");

    await setAdminFeatureEnabled("site", false);
    expect((await route("/events")).status).toBe(404);
  });

  test("does not redirect a nested legacy events path", async () => {
    await enablePublicSite();
    expect((await route("/events/extra")).status).toBe(404);
  });

  test("serves only the exact order script path", async () => {
    expect((await route("/order.js")).status).toBe(200);
    expect((await route("/order.js/extra")).status).toBe(404);
  });

  test("serves custom CSS on its exact path", async () => {
    expect((await route("/custom.css")).status).toBe(200);
  });

  test("routes the enabled public API without admin authentication", async () => {
    await enablePublicApi();
    expect((await route("/api/listings")).status).toBe(200);
  });

  test("serves the enabled contact page for GET", async () => {
    await enablePublicSite();
    await settings.update.contactPageText("Contact us.");
    expect((await route("/contact")).status).toBe(200);
  });

  test("routes contact form POST requests", async () => {
    await enablePublicSite();
    await settings.update.businessEmail("owner@example.com");
    await settings.update.contactFormEnabled(true);
    expect((await route("/contact", "POST")).status).toBe(302);
  });

  test("serves the read-only information page only for GET", async () => {
    expect((await route("/read-only")).status).toBe(200);
    expect((await route("/read-only", "HEAD")).status).toBe(404);
  });

  test("applies the read-only guard before loading a route group", async () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const response = await route("/ticket/missing", "POST");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/read-only");
  });

  test("returns the read-only API error for blocked API writes", async () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });

    const response = await route("/api/listings", "POST");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "This site is in read-only mode",
    });
  });
});
