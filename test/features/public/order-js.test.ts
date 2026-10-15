import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { groups } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { getAllListings } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { orderWidgetBody } from "#routes/assets.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { says } from "#test-utils/says.ts";

const orderJs = (origin?: string): Promise<Response> =>
  handleRequest(
    mockRequest("/order.js", origin ? { headers: { origin } } : {}),
  );

const orderJsPath = (path: string): Promise<Response> =>
  handleRequest(mockRequest(path));

/** Slug of the created listing, looked up by name so the result is independent
 * of insertion order. */
const slugByName = async (name: string): Promise<string> => {
  const listings = await getAllListings();
  const match = listings.find((listing) => listing.name === name);
  if (!match) throw new Error(`listing not found: ${name}`);
  return match.slug;
};

describeWithEnv("order.js", { db: true, triggers: true }, () => {
  test("disabled by default: returns the console stub with ACAO *", async () => {
    const res = await orderJs("https://shop.example.com");
    const body = await res.text();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    says(res.headers.get("content-type"), "javascript");
    says(body, "not enabled");
    assert(!body.includes("const CATALOG"));
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
    says(body, "const CATALOG");
    says(body, slug);
    says(body, "isExternalOrderModule");
  });

  test("includes a concealed package's members in the catalog", async () => {
    await settings.update.externalOrderEnabled(true);
    const group = await createHiddenPackageGroup("Bundle");
    await createTestListing({ groupId: group.id, name: "Hidden Member" });
    await createTestListing({ name: "Standalone" });
    const memberSlug = await slugByName("Hidden Member");
    const standaloneSlug = await slugByName("Standalone");

    const body = await (await orderJs()).text();
    says(body, standaloneSlug);
    says(body, memberSlug);
  });

  test("advertises a bookable package's bundle slug in the catalog packages", async () => {
    await settings.update.externalOrderEnabled(true);
    const group = await createTestGroup({
      isPackage: true,
      name: "Camp Bundle",
      slug: "camp-bundle",
    });
    await createTestListing({ groupId: group.id, name: "Tent" });

    const body = await (await orderJs()).text();
    // The bundle is bookable via /ticket/<group>, so its slug rides in the
    // packages map even though it's not a listing cart line.
    says(body, '"packages"');
    says(body, '"camp-bundle"');
  });

  test("a hidden package's bundle is still bookable from the widget", async () => {
    await settings.update.externalOrderEnabled(true);
    const group = await createTestGroup({
      isPackage: true,
      name: "Secret Bundle",
      slug: "secret-bundle",
    });
    await groups.table.update(group.id, { hidePackageListings: true });
    const member = await createTestListing({
      groupId: group.id,
      name: "Concealed",
    });
    const memberSlug = await slugByName("Concealed");

    const body = await (await orderJs()).text();
    // Both booking paths stay available in the widget.
    says(body, '"secret-bundle"');
    says(body, `"${memberSlug}"`);
    says(body, member.name);
  });

  test("omits an unbookable package (an inactive member) from the catalog", async () => {
    await settings.update.externalOrderEnabled(true);
    const group = await createTestGroup({
      isPackage: true,
      name: "Gone Bundle",
      slug: "gone-bundle",
    });
    const member = await createTestListing({
      groupId: group.id,
      name: "Last One",
    });
    await deactivateTestListing(member.id);

    const body = await (await orderJs()).text();
    // The bundle can't sell (its sole member is inactive), so it isn't advertised.
    assert(!body.includes('"gone-bundle"'));
  });

  test("defaults the catalog debug flag off without the query param", async () => {
    await settings.update.externalOrderEnabled(true);

    const body = await (await orderJs()).text();
    says(body, '"debug":false');
    assert(!body.includes('"debug":true'));
  });

  test("debug=true bakes the verbose-logging flag into the catalog", async () => {
    await settings.update.externalOrderEnabled(true);

    const body = await (await orderJsPath("/order.js?debug=true")).text();
    says(body, '"debug":true');
    assert(!body.includes('"debug":false'));
  });

  test("a non-true debug value leaves verbose logging off", async () => {
    await settings.update.externalOrderEnabled(true);

    const body = await (await orderJsPath("/order.js?debug=1")).text();
    says(body, '"debug":false');
  });

  test("marks a pay-what-you-want listing as variable-price in the catalog", async () => {
    await settings.update.externalOrderEnabled(true);
    // Not daily, not customisable — can_pay_more is the only variable-price
    // trigger, so it must survive the SQLite 0/1 → boolean conversion.
    await createTestListing({ canPayMore: true, name: "Pay What You Want" });

    const body = await (await orderJs()).text();
    says(body, '"variablePrice":true');
    assert(!body.includes('"variablePrice":false'));
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
    says(body, '"variablePrice":true');
    assert(!body.includes('"variablePrice":false'));
  });

  test("excludes hidden listings from the embedded catalog", async () => {
    await settings.update.externalOrderEnabled(true);
    await createTestListing({ hidden: true, name: "Secret Listing" });
    const slug = await slugByName("Secret Listing");

    const body = await (await orderJs()).text();
    says(body, "const CATALOG");
    assert(!body.includes(slug));
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
    says(body, "const CATALOG");
    assert(!body.includes(slug));
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
    says(body, "const CATALOG");
    says(body, slug);
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
    says(body, "const CATALOG");
    assert(!body.includes(tier.slug));
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
    await listingChildren.setIds(parent.id, [child.id]);

    const body = await (await orderJs()).text();
    says(body, "const CATALOG");
    says(body, parent.slug);
    assert(!body.includes(child.slug));
  });

  test("caches the widget body so it is not re-read from disk per request", () => {
    // The first call may or may not have already cached the body (test order is
    // not fixed), so assert the invariant directly: a *subsequent* call must
    // not hit the disk again. Without the cache, every call re-reads the file.
    const readSpy = spy(Deno, "readTextFileSync");
    try {
      orderWidgetBody();
      const afterFirst = readSpy.calls.length;
      orderWidgetBody();
      expect(readSpy.calls.length).toBe(afterFirst);
    } finally {
      readSpy.restore();
    }
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
    says(body, "const CATALOG");
    says(body, slug);
  });

  test("a disallowed origin gets no CORS header, no catalog, and no slugs", async () => {
    await settings.update.externalOrderEnabled(true);
    await settings.update.embedHosts("shop.example.com");
    await createTestListing({ name: "Hidden From Evil" });
    const slug = await slugByName("Hidden From Evil");

    const denied = await orderJs("https://evil.example.com");
    const body = await denied.text();
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    assert(!body.includes("const CATALOG"));
    assert(!body.includes(slug));
  });
});
