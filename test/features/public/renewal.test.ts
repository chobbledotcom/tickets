/**
 * The renewal route's own decisions: which site a token names, which tiers that
 * site offers, and which line introduces the picker. The booking journey the
 * route hands off to lives in test/integration/routes/renewal.test.ts.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { renewalTestSite } from "#test-utils/db-helpers/built-sites.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";

const DEADLINE = "2026-09-01T00:00:00Z";

const addTier = (name: string, months: number, price: number) =>
  createTestListing({
    hidden: true,
    maxAttendees: 100,
    maxQuantity: 12,
    monthsPerUnit: months,
    name,
    purchaseOnly: true,
    unitPrice: price,
  });

const visit = (token: string) =>
  handleRequest(mockRequest(`/renew/?t=${encodeURIComponent(token)}`));

describeWithEnv("routes > renewal (token and tiers)", { db: true }, () => {
  test("refuses a request carrying no token", async () => {
    const response = await handleRequest(mockRequest("/renew/"));
    expect(response.status).toBe(404);
  });

  test("refuses a token that names no site", async () => {
    const response = await handleRequest(mockRequest("/renew/?t=not-a-token"));
    expect(response.status).toBe(404);
  });

  test("says renewal is unavailable when no tier qualifies", async () => {
    const { token } = await renewalTestSite();

    const html = await expectHtmlResponse(
      await visit(token),
      200,
      "Renewal Unavailable",
      "no longer valid",
    );
    expect(html).not.toContain("quantity_");
  });

  test("asks the customer to pick when more than one tier is offered", async () => {
    await addTier("Monthly tier", 1, 500);
    await addTier("Annual tier", 12, 5000);
    const { token } = await renewalTestSite("Two Tier Site", {
      readOnlyFrom: DEADLINE,
    });

    const html = await expectHtmlResponse(
      await visit(token),
      200,
      "Pick a tier and quantity below",
    );
    expect(html).not.toContain("You are renewing");
  });

  test("names the tier instead of asking, when only one is offered", async () => {
    await addTier("Monthly tier", 1, 500);
    const { token } = await renewalTestSite("One Tier Site", {
      readOnlyFrom: DEADLINE,
    });

    const html = await expectHtmlResponse(
      await visit(token),
      200,
      "You are renewing Monthly tier. Choose how many below.",
    );
    expect(html).not.toContain("Pick a tier and quantity below");
  });

  test("posts the form back to the same token", async () => {
    await addTier("Monthly tier", 1, 500);
    const { token } = await renewalTestSite("Action Url Site");

    const html = await expectHtmlResponse(await visit(token), 200, "Renew");
    expect(html).toContain(`/renew/?t=${encodeURIComponent(token)}`);
  });

  test("leads with the deadline only when the site has one", async () => {
    await addTier("Monthly tier", 1, 500);
    const { token: dated } = await renewalTestSite("Dated Site", {
      readOnlyFrom: DEADLINE,
    });
    const { token: undated } = await renewalTestSite("Undated Site");

    expect(await (await visit(dated)).text()).toContain(
      "Current deadline: Tuesday 1 September 2026.",
    );
    expect(await (await visit(undated)).text()).not.toContain(
      "Current deadline:",
    );
  });
});
