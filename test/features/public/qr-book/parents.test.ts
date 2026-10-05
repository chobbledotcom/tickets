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
});
