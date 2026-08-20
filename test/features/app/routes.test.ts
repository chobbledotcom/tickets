import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setAdminFeatureEnabled } from "#db/admin-features.ts";
import { builtSites, insertBuiltSite } from "#db/built-sites.ts";
import { settings } from "#db/settings.ts";
import { routeMainApp } from "#routes/app/routes.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { provisionTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { withEnv } from "#test-utils/env.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { enablePublicApi, enablePublicSite } from "#test-utils/settings.ts";

const routeRequest = async (
  request: Request,
  path: string,
  method: string,
): Promise<Response> => {
  const response = await routeMainApp({
    method,
    path,
    request,
    server: undefined,
  });
  return response;
};

const route = (path: string, method = "GET"): Promise<Response> =>
  routeRequest(mockRequest(path, { method }), path, method);

const routeRenewal = async (method: string): Promise<Response> => {
  await insertBuiltSite("Route Renewal Site", "route-renewal.b-cdn.net");
  const site = (await builtSites.getAll()).find(
    ({ name }) => name === "Route Renewal Site",
  );
  if (!site) throw new Error("Route renewal site not found");
  const { token } = await provisionTestBuiltSite(site.id);
  return routeRequest(
    mockRequest(`/renew?t=${encodeURIComponent(token)}`, { method }),
    "/renew",
    method,
  );
};

describeWithEnv("main app router", { db: true }, () => {
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

  test("does not expose scheduled maintenance through the app router", async () => {
    expect((await route("/scheduled", "POST")).status).toBe(404);
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

  test("routes configured address lookup on its exact path", async () => {
    await settings.update.addressLookup.provider("easypostcodes");
    await settings.update.addressLookup.apiKey("test-api-key");

    expect((await route("/address-lookup")).status).toBe(400);
  });

  test("routes renewal GET requests", async () => {
    expect((await routeRenewal("GET")).status).toBe(200);
  });

  test("routes renewal POST requests", async () => {
    expect((await routeRenewal("POST")).status).toBe(200);
  });

  test("routes unsubscribe GET requests", async () => {
    expect((await route("/unsubscribe")).status).toBe(200);
  });

  test("routes unsubscribe POST requests", async () => {
    const request = mockFormRequest("/unsubscribe", {
      csrf_token: await signCsrfToken(),
    });

    expect((await routeRequest(request, "/unsubscribe", "POST")).status).toBe(
      302,
    );
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
