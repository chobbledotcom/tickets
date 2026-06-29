import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getAllListings } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { createTestListing, describeWithEnv, mockRequest } from "#test-utils";

const orderJs = (origin?: string): Promise<Response> =>
  handleRequest(
    mockRequest("/order.js", origin ? { headers: { origin } } : {}),
  );

/** Slug of the created listing, looked up by name so the result is independent
 * of insertion order. */
const slugByName = async (name: string): Promise<string> => {
  const listings = await getAllListings();
  const match = listings.find((listing) => listing.name === name);
  if (!match) throw new Error(`listing not found: ${name}`);
  return match.slug;
};

describeWithEnv("order.js handler", { db: true, triggers: true }, () => {
  test("disabled by default: returns the console stub with ACAO *", async () => {
    const res = await orderJs("https://shop.example.com");
    const body = await res.text();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(body).toContain("not enabled");
    expect(body).not.toContain("const CATALOG");
  });

  test("enabled with empty allow-list: embeds catalog with ACAO *", async () => {
    await settings.update.externalOrderEnabled(true);
    await createTestListing({ name: "Public Workshop" });
    const slug = await slugByName("Public Workshop");

    const res = await orderJs("https://anywhere.example.com");
    const body = await res.text();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("const CATALOG");
    expect(body).toContain(slug);
    expect(body).toContain("isExternalOrderModule");
  });

  test("excludes hidden listings from the embedded catalog", async () => {
    await settings.update.externalOrderEnabled(true);
    await createTestListing({ hidden: true, name: "Secret Listing" });
    const slug = await slugByName("Secret Listing");

    const body = await (await orderJs()).text();
    expect(body).toContain("const CATALOG");
    expect(body).not.toContain(slug);
  });

  test("a Hidden=true default hides a use-defaults listing from the catalog", async () => {
    await settings.update.externalOrderEnabled(true);
    await settings.update.listingDefaults({ hidden: true });
    // Stored hidden=0, but it inherits the Hidden default, so it must not ship.
    await createTestListing({
      hidden: false,
      name: "Inherits Hidden",
      useDefaults: true,
    });
    const slug = await slugByName("Inherits Hidden");

    const body = await (await orderJs()).text();
    expect(body).toContain("const CATALOG");
    expect(body).not.toContain(slug);
  });

  test("a Hidden=false default reveals a use-defaults listing stored as hidden", async () => {
    await settings.update.externalOrderEnabled(true);
    await settings.update.listingDefaults({ hidden: false });
    // Stored hidden=1, but the Hidden=No default makes it effectively visible.
    await createTestListing({
      hidden: true,
      name: "Inherits Visible",
      useDefaults: true,
    });
    const slug = await slugByName("Inherits Visible");

    const body = await (await orderJs()).text();
    expect(body).toContain("const CATALOG");
    expect(body).toContain(slug);
  });

  test("a non-/order.js path under the prefix is not handled (404)", async () => {
    await settings.update.externalOrderEnabled(true);
    const res = await handleRequest(mockRequest("/order.js/extra"));
    expect(res.status).toBe(404);
  });

  test("allow-list echoes an allowed origin and serves the catalog", async () => {
    await settings.update.externalOrderEnabled(true);
    await settings.update.embedHosts("shop.example.com");
    await createTestListing({ name: "Allowed Workshop" });
    const slug = await slugByName("Allowed Workshop");

    const allowed = await orderJs("https://shop.example.com");
    const body = await allowed.text();
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://shop.example.com",
    );
    expect(body).toContain("const CATALOG");
    expect(body).toContain(slug);
  });

  test("a disallowed origin gets no CORS header, no catalog, and no slugs", async () => {
    await settings.update.externalOrderEnabled(true);
    await settings.update.embedHosts("shop.example.com");
    await createTestListing({ name: "Hidden From Evil" });
    const slug = await slugByName("Hidden From Evil");

    const denied = await orderJs("https://evil.example.com");
    const body = await denied.text();
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(body).not.toContain("const CATALOG");
    expect(body).not.toContain(slug);
  });
});
