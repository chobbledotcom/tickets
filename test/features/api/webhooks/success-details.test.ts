// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { deleteListing } from "#db/listings/delete.ts";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks/stripe.ts";

// jscpd:ignore-end

const successRequest = (query: string): Request =>
  mockRequest(`/payment/success?${query}`);

describeWithEnv("server (payment success details)", { db: true }, () => {
  test("direct success keeps separators between every stored token", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Stored",
      "stored@example.com",
    );
    await finalizeProcessedPayment(
      "cs_direct_tokens",
      attendee.id,
      "first-token+second-token",
    );
    using _retrieve = stubRetrieveCheckoutSession({
      amountTotal: 500,
      email: "stored@example.com",
      items: singleItem(listing.id, 1, 500),
      metadata: signedMeta(
        {
          email: "stored@example.com",
          items: singleItem(listing.id, 1, 500),
          name: "Stored",
          thank_you_url: "https://direct.example.com/thanks",
        },
        500,
      ),
      name: "Stored",
      paymentIntent: "pi_direct_tokens",
      sessionId: "cs_direct_tokens",
    });

    const html = await (
      await handleRequest(successRequest("session_id=cs_direct_tokens"))
    ).text();

    expect(html).toContain("/t/first-token+second-token");
  });

  test("redirect encodes separators between every stored token", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Redirect",
      "redirect@example.com",
    );
    await finalizeProcessedPayment(
      "cs_redirect_tokens",
      attendee.id,
      "first-token+second-token",
    );
    using _retrieve = stubRetrieveCheckoutSession({
      amountTotal: 500,
      email: "redirect@example.com",
      items: singleItem(listing.id, 1, 500),
      name: "Redirect",
      paymentIntent: "pi_redirect_tokens",
      sessionId: "cs_redirect_tokens",
    });

    const response = await handleRequest(
      successRequest("session_id=cs_redirect_tokens"),
    );

    expect(response.headers.get("location")).toBe(
      "/payment/success?tokens=first-token%2Bsecond-token",
    );
  });

  test("an explicit thank-you URL is not replaced on a replay", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 5,
      thankYouUrl: "https://listing.example.com/thanks",
      unitPrice: 500,
    });
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Explicit",
      "explicit@example.com",
    );
    await finalizeProcessedPayment("cs_explicit_replay", attendee.id, "");
    using _retrieve = stubRetrieveCheckoutSession({
      amountTotal: 500,
      email: "explicit@example.com",
      items: singleItem(listing.id, 1, 500),
      metadata: signedMeta(
        {
          email: "explicit@example.com",
          items: singleItem(listing.id, 1, 500),
          name: "Explicit",
          thank_you_url: "https://explicit.example.com/thanks",
        },
        500,
      ),
      name: "Explicit",
      paymentIntent: "pi_explicit_replay",
      sessionId: "cs_explicit_replay",
    });

    const html = await (
      await handleRequest(successRequest("session_id=cs_explicit_replay"))
    ).text();

    expect(html).toContain("https://explicit.example.com/thanks");
    expect(html).not.toContain("https://listing.example.com/thanks");
  });

  test("a deleted listing adds no made-up thank-you URL on a replay", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Deleted",
      "deleted@example.com",
    );
    await finalizeProcessedPayment("cs_deleted_replay", attendee.id, "");
    await deleteListing(listing.id);
    using _retrieve = stubRetrieveCheckoutSession({
      amountTotal: 500,
      email: "deleted@example.com",
      items: singleItem(listing.id, 1, 500),
      metadata: signedMeta(
        {
          email: "deleted@example.com",
          items: singleItem(listing.id, 1, 500),
          name: "Deleted",
        },
        500,
      ),
      name: "Deleted",
      paymentIntent: "pi_deleted_replay",
      sessionId: "cs_deleted_replay",
    });

    const html = await (
      await handleRequest(successRequest("session_id=cs_deleted_replay"))
    ).text();

    expect(html).toContain('data-payment-result="success"');
    expect(html).not.toContain("mutated");
  });

  test("tokens keep the thank-you URL for a visible listing", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      thankYouUrl: "https://visible.example.com/thanks",
    });
    const { token } = await createTestAttendeeDirect(
      listing.id,
      "Visible",
      "visible@example.com",
    );

    const html = await (
      await handleRequest(successRequest(`tokens=${encodeURIComponent(token)}`))
    ).text();

    expect(html).toContain("https://visible.example.com/thanks");
  });

  test("tokens hide the thank-you URL of a hidden package member", async () => {
    const group = await createHiddenPackageGroup();
    const listing = await createTestListing({
      groupId: group.id,
      maxAttendees: 5,
      thankYouUrl: "https://hidden.example.com/thanks",
    });
    const { attendee, token } = await createTestAttendeeDirect(
      listing.id,
      "Hidden",
      "hidden@example.com",
    );
    await getDb().execute({
      args: [group.id, attendee.id],
      sql: "UPDATE listing_attendees SET package_group_id = ? WHERE attendee_id = ?",
    });

    const html = await (
      await handleRequest(successRequest(`tokens=${encodeURIComponent(token)}`))
    ).text();

    expect(html).not.toContain("https://hidden.example.com/thanks");
    expect(html).not.toContain("mutated");
  });

  test("tokens keep separators and omit a multi-listing thank-you URL", async () => {
    const first = await createTestListing({ maxAttendees: 5 });
    const second = await createTestListing({ maxAttendees: 5 });
    const { token: firstToken } = await createTestAttendeeDirect(
      first.id,
      "First",
      "first@example.com",
    );
    const { token: secondToken } = await createTestAttendeeDirect(
      second.id,
      "Second",
      "second@example.com",
    );
    const tokens = `${firstToken}+${secondToken}`;

    const html = await (
      await handleRequest(
        successRequest(`tokens=${encodeURIComponent(tokens)}`),
      )
    ).text();

    expect(html).toContain(`/t/${tokens}`);
    expect(html).not.toContain("mutated");
  });
});
