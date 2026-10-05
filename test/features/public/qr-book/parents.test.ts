import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingChildren } from "#db/listing-parents.ts";
import { buildQrBookPayload, signQrBookToken } from "#shared/qr-token.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { expectStripeRedirect, qrBookPath, withStripe } from "./helpers.ts";

interface ParentChildToken {
  child: Awaited<ReturnType<typeof createTestListing>>;
  token: string;
  tokenSlug: string;
}

describeWithEnv("QR booking parent gate", { db: true }, () => {
  const parentChildToken = async (
    slug: (ids: { parent: string; child: string }) => string,
  ): Promise<ParentChildToken> => {
    const parent = await createTestListing({
      fields: "",
      maxAttendees: 10,
      unitPrice: 500,
    });
    const child = await createTestListing({
      maxAttendees: 10,
      name: "Add-on",
      unitPrice: 0,
    });
    await listingChildren.setIds(parent.id, [child.id]);
    const tokenSlug = slug({ child: child.slug, parent: parent.slug });
    const token = await signQrBookToken(
      tokenSlug,
      buildQrBookPayload({ name: "Ada", value: 1000 }),
    );
    return { child, token, tokenSlug };
  };

  test("a parent with a required child renders the form", async () => {
    const { token, tokenSlug } = await parentChildToken((ids) => ids.parent);
    await withStripe(async (stripe) => {
      const response = await awaitTestRequest(qrBookPath(tokenSlug, token));
      expect(response.status).toBe(200);
      expect(stripe.calls()).toBe(0);
    });
  });

  test("a required child's QR has no fallback booking link", async () => {
    const { child, token, tokenSlug } = await parentChildToken(
      (ids) => ids.child,
    );
    const response = await awaitTestRequest(qrBookPath(tokenSlug, token));
    const html = await response.text();

    expect(response.status).toBe(404);
    expect(html).toContain("QR code expired or invalid");
    expect(html).not.toContain(`href="/ticket/${child.slug}"`);
  });

  test("a childless listing still skips to checkout", async () => {
    const listing = await createTestListing({
      fields: "",
      maxAttendees: 10,
      unitPrice: 500,
    });
    const token = await signQrBookToken(
      listing.slug,
      buildQrBookPayload({ name: "Ada", value: 1000 }),
    );
    await withStripe(async (stripe) => {
      const response = await awaitTestRequest(qrBookPath(listing.slug, token));
      expectStripeRedirect(response, stripe);
    });
  });

  test("a token minted below a later minimum renders the form, not checkout", async () => {
    // The token is signed while the listing sells one-at-a-time; the owner
    // then raises the minimum. The stale quantity must never reach checkout.
    const listing = await createTestListing({
      fields: "",
      maxAttendees: 10,
      maxQuantity: 10,
      minimumQuantity: 3,
      unitPrice: 500,
    });
    const staleToken = await signQrBookToken(
      listing.slug,
      buildQrBookPayload({ name: "Ada", quantity: 1, value: 1000 }),
    );
    await withStripe(async (stripe) => {
      const response = await awaitTestRequest(
        qrBookPath(listing.slug, staleToken),
      );
      expect(response.status).toBe(200);
      expect(stripe.calls()).toBe(0);
    });

    const freshToken = await signQrBookToken(
      listing.slug,
      buildQrBookPayload({ name: "Ada", quantity: 3, value: 1000 }),
    );
    await withStripe(async (stripe) => {
      const response = await awaitTestRequest(
        qrBookPath(listing.slug, freshToken),
      );
      expectStripeRedirect(response, stripe);
    });
  });
});
