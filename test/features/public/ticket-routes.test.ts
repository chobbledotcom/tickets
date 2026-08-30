/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { handleTicketQrGet } from "#routes/public/ticket-routes.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  connectResendProvider,
  enablePublicSite,
} from "#test-utils/settings.ts";

/* jscpd:ignore-end */

/** Submit a purchase-only order and return the reserved page's redirect. */
const reservedOrder = async (slug: string): Promise<string> => {
  const response = await submitTicketForm(slug, {
    email: "jane@example.com",
    name: "Jane Doe",
  });
  const location = response.headers.get("location") ?? "";
  expect(location).toContain("/ticket/reserved?tokens=");
  return location;
};

describeWithEnv("public ticket routes", { db: true }, () => {
  test("a listing's QR answers with an SVG of its ticket address", async () => {
    await enablePublicSite();
    const listing = await createTestListing({ name: "Kayak Tour" });
    const response = await handleTicketQrGet(mockRequest("/"), {
      slug: listing.slug,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(await response.text()).toContain("svg");
  });

  test("an unknown slug has no QR", async () => {
    const response = await handleTicketQrGet(mockRequest("/"), {
      slug: "no-such-thing",
    });
    expect(response.status).toBe(404);
  });

  test("a group's QR exists only while the group offers something bookable", async () => {
    await enablePublicSite();
    // A memberless group renders no bookable quantity, so its QR 404s.
    const empty = await createTestGroup({ name: "Empty Barn" });
    const refused = await handleTicketQrGet(mockRequest("/"), {
      slug: empty.slug,
    });
    expect(refused.status).toBe(404);

    const bookable = await createTestGroup({ name: "Full Barn" });
    await createTestListing({ groupId: bookable.id, name: "Full Barn Stall" });
    const served = await handleTicketQrGet(mockRequest("/"), {
      slug: bookable.slug,
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/svg+xml");
  });

  test("the ticket page answers a group slug the listing path cannot", async () => {
    await enablePublicSite();
    const group = await createTestGroup({ name: "Stargazing" });
    await createTestListing({ groupId: group.id, name: "Stargazing Slot" });
    const response = await handleRequest(mockRequest(`/ticket/${group.slug}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Stargazing");
  });

  /** Book one purchase-only listing and read its reserved page. */
  const reservedPageHtml = async (name: string): Promise<string> => {
    await enablePublicSite();
    const listing = await createTestListing({
      maxAttendees: 50,
      name: name,
      purchaseOnly: true,
      thankYouUrl: "",
    });
    return await (
      await handleRequest(mockRequest(await reservedOrder(listing.slug)))
    ).text();
  };

  test("the reserved page links a one-listing order's ticket, and hides the from-address while email is off", async () => {
    const html = await reservedPageHtml("Quiet Order");
    expect(html).toContain("Thank you for your order");
    expect(html).toMatch(/\/t\/[A-Za-z0-9+-]+/);
    expect(html).not.toContain("will be sent from");

    // With no tokens at all the page still renders, and still names no sender.
    const bare = await (
      await handleRequest(mockRequest("/ticket/reserved"))
    ).text();
    expect(bare).toContain("Thank you for your order");
    expect(bare).not.toContain("will be sent from");
  });

  test("the reserved page names the sending address once email is configured", async () => {
    await connectResendProvider();
    await settings.update.businessEmail("owner@example.com");
    const html = await reservedPageHtml("Chatty Order");
    expect(html).toContain("sent from owner@example.com");
  });

  test("a two-order reserved page joins its tokens, and a space still resolves them", async () => {
    await enablePublicSite();
    const kayak = await createTestListing({
      maxAttendees: 50,
      name: "Reserved Kayak",
      purchaseOnly: true,
      thankYouUrl: "",
    });
    const sauna = await createTestListing({
      maxAttendees: 50,
      name: "Reserved Sauna",
      purchaseOnly: true,
      thankYouUrl: "",
    });
    const tokenOf = async (slug: string): Promise<string> =>
      new URL(await reservedOrder(slug), "http://localhost").searchParams.get(
        "tokens",
      ) ?? "";
    const tokens = `${await tokenOf(kayak.slug)}+${await tokenOf(sauna.slug)}`;

    // The booking CTA carries both tokens joined by the URL's own "+".
    const html = await (
      await handleRequest(mockRequest(`/ticket/reserved?tokens=${tokens}`))
    ).text();
    expect(html).toContain(`/t/${tokens}`);

    // A space where the URL shows "+" resolves to the same order.
    const spaced = await (
      await handleRequest(
        mockRequest(`/ticket/reserved?tokens=${tokens.replaceAll("+", " ")}`),
      )
    ).text();
    expect(spaced).toContain(`/t/${tokens}`);
  });

  test("a single package slug renders the package form, not the cart", async () => {
    await enablePublicSite();
    const group = await createTestGroup({
      description: "The package page names what the group page says.",
      isPackage: true,
      name: "Solo Pkg",
    });
    await createTestListing({ groupId: group.id, name: "Solo Pkg Stall" });
    const response = await handleRequest(mockRequest(`/ticket/${group.slug}`));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`name="package_quantity_${group.id}"`);
    // Only the group fallback renders the description; the lone-package cart
    // path would drop it.
    expect(html).toContain("The package page names what the group page says.");
  });

  test("a package booked beside a listing renders the cart's package section", async () => {
    await enablePublicSite();
    // Only the cart path can render a package next to a standalone listing;
    // the listing-only path cannot resolve the package slug.
    const group = await createTestGroup({ isPackage: true, name: "Combo Pkg" });
    await createTestListing({
      groupId: group.id,
      name: "Combo Pkg Stall",
      unitPrice: 1000,
    });
    const addon = await createTestListing({ name: "Combo Addon" });
    const response = await handleRequest(
      mockRequest(`/ticket/${group.slug}+${addon.slug}`),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`name="package_quantity_${group.id}"`);
    expect(html).toContain("Combo Pkg Stall");
    expect(html).toContain("Combo Addon");
  });

  test("a multi-slug page renders the cart, and a mixed unknown cart stays 404", async () => {
    await enablePublicSite();
    const kayak = await createTestListing({ name: "Cart Kayak" });
    const sauna = await createTestListing({ name: "Cart Sauna" });
    const cart = await handleRequest(
      mockRequest(`/ticket/${kayak.slug}+${sauna.slug}`),
    );
    expect(cart.status).toBe(200);
    const html = await cart.text();
    expect(html).toContain("Cart Kayak");
    expect(html).toContain("Cart Sauna");

    const group = await createTestGroup({ name: "Cart Decoy Group" });
    await createTestListing({ groupId: group.id, name: "Cart Decoy Stall" });
    const mixed = await handleRequest(
      mockRequest(`/ticket/${group.slug}+no-such-listing`),
    );
    expect(mixed.status).toBe(404);
  });
});
