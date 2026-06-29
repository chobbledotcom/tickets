import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { groupsTable } from "#shared/db/groups.ts";
import { setChildIds } from "#shared/db/listing-parents.ts";
import { getAllListings } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
  mockRequest,
} from "#test-utils";

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

  test("excludes a hidden package's members from the catalog", async () => {
    await settings.update.externalOrderEnabled(true);
    const group = await createTestGroup({ isPackage: true, name: "Bundle" });
    await groupsTable.update(group.id, { hidePackageListings: true });
    await createTestListing({ groupId: group.id, name: "Hidden Member" });
    await createTestListing({ name: "Standalone" });
    const memberSlug = await slugByName("Hidden Member");
    const standaloneSlug = await slugByName("Standalone");

    const body = await (await orderJs()).text();
    // The standalone listing is advertised; the hidden package's member is not.
    expect(body).toContain(standaloneSlug);
    expect(body).not.toContain(memberSlug);
  });

  test("marks a pay-what-you-want listing as variable-price in the catalog", async () => {
    await settings.update.externalOrderEnabled(true);
    // Not daily, not customisable — can_pay_more is the only variable-price
    // trigger, so it must survive the SQLite 0/1 → boolean conversion.
    await createTestListing({ canPayMore: true, name: "Pay What You Want" });

    const body = await (await orderJs()).text();
    expect(body).toContain('"variablePrice":true');
    expect(body).not.toContain('"variablePrice":false');
  });

  test("marks a customisable-days listing as variable-price in the catalog", async () => {
    await settings.update.externalOrderEnabled(true);
    await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 0, 2: 0 },
      durationDays: 2,
      name: "Customisable",
    });

    const body = await (await orderJs()).text();
    expect(body).toContain('"variablePrice":true');
    expect(body).not.toContain('"variablePrice":false');
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

  test("a Hidden=No default never reveals a renewal tier", async () => {
    await settings.update.externalOrderEnabled(true);
    await settings.update.listingDefaults({ hidden: false });
    // A renewal tier (months_per_unit > 0) is excluded from the inheriting set,
    // so a Hidden=No default can't surface it — it must stay hidden (or renewal
    // extension breaks). Guards catalogVisibleSql's renewal-tier clause against
    // drift from resolveListingDefaults' hidden gate.
    const tier = await createTestListing({
      hidden: true,
      monthsPerUnit: 12,
      name: "Renewal Tier",
      purchaseOnly: true,
      useDefaults: true,
    });

    const body = await (await orderJs()).text();
    expect(body).toContain("const CATALOG");
    expect(body).not.toContain(tier.slug);
  });

  test("excludes a required child even when a Hidden=No default would reveal it", async () => {
    await settings.update.externalOrderEnabled(true);
    await settings.update.listingDefaults({ hidden: false });
    const parent = await createTestListing({ name: "Parent" });
    // Stored hidden, but inherits the Hidden=No default — without the child
    // exclusion it would surface in the catalog, and its Continue URL 404s
    // because /ticket/<child> is only reachable through the parent.
    const child = await createTestListing({
      hidden: true,
      name: "Required Child",
      useDefaults: true,
    });
    await setChildIds(parent.id, [child.id]);

    const body = await (await orderJs()).text();
    expect(body).toContain("const CATALOG");
    expect(body).toContain(parent.slug);
    expect(body).not.toContain(child.slug);
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
