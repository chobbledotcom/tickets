import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

describeWithEnv("request entry point", { db: true }, () => {
  test("runs an ordinary page through routing and response security", async () => {
    await enablePublicSite();
    const response = await handleRequest(mockRequest("/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("keeps ticket pages embeddable inside the request scopes", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const response = await handleRequest(
      mockRequest(`/ticket/${listing.slug}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("x-robots-tag")).toBe("index, follow");
  });

  test("uses the configured payment provider in response security", async () => {
    await settings.update.paymentProvider("square");
    await settings.update.square.sandbox(true);
    const response = await handleRequest(mockRequest("/"));
    expect(response.headers.get("content-security-policy")).toContain(
      "https://connect.squareupsandbox.com",
    );
  });
});
