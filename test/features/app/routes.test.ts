import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { routeMainApp } from "#routes/app/routes.ts";
import { setAdminFeatureEnabled } from "#shared/db/admin-features.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

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
});
