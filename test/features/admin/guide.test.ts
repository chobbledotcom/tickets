import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { adminHandlers } from "#routes/admin/guide.ts";
import { hostEmail } from "#shared/email.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { validEmail } from "#test-utils/email.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { getTestSession } from "#test-utils/session.ts";

/** Opens one of the guide's own routes as the owner. */
const openAsOwner = async (route: keyof typeof adminHandlers, path: string) => {
  const { cookie } = await getTestSession();
  const handler = adminHandlers[route] as (
    request: Request,
  ) => Promise<Response>;
  return handler(mockRequest(path, { headers: { cookie } }));
};

describeWithEnv("admin guide routes", { db: true }, () => {
  afterEach(() => {
    hostEmail.resetOverride();
  });

  test("serves the staff guide", async () => {
    const response = await openAsOwner("GET /admin/guide", "/admin/guide");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Guide");
  });

  test("serves the formatting help on its own route", async () => {
    const response = await openAsOwner(
      "GET /admin/formatting",
      "/admin/formatting",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Text Formatting");
  });

  test("shows nothing about host email when the host has none", async () => {
    hostEmail.setOverride(null);
    const html = await (
      await openAsOwner("GET /admin/guide", "/admin/guide")
    ).text();
    expect(html).not.toContain("host@example.com");
  });

  test("names the host's from-address and provider when it has them", async () => {
    hostEmail.setOverride({
      apiKey: "key",
      fromAddress: validEmail("host@example.com"),
      provider: "resend",
    });
    const html = await (
      await openAsOwner("GET /admin/guide", "/admin/guide")
    ).text();
    expect(html).toContain("host@example.com");
    expect(html).toContain("Resend");
  });

  test("turns an unauthenticated visitor away", async () => {
    const handler = adminHandlers["GET /admin/guide"] as (
      request: Request,
    ) => Promise<Response>;
    const response = await handler(mockRequest("/admin/guide"));
    expect(response.status).toBe(302);
  });
});
