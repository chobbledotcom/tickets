import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handlePaymentSuccess } from "#routes/api/payment-success.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  type CheckoutLine,
  stubPaidCheckout,
} from "#test-utils/payment-session.ts";
import { setupStripe } from "#test-utils/settings.ts";

describeWithEnv("the paid success token page", { db: true }, () => {
  const paidListing = (
    overrides: Parameters<typeof createTestListing>[0] = {},
  ) => createTestListing({ maxAttendees: 50, unitPrice: 500, ...overrides });

  /** Book one paid checkout and return the ticket token its redirect hands
   *  the buyer. */
  const bookToken = async (
    sessionId: string,
    items: readonly CheckoutLine[],
  ): Promise<string> => {
    using _provider = await stubPaidCheckout(sessionId, items);
    const response = await handlePaymentSuccess(
      new Request(`http://localhost/payment/success?session_id=${sessionId}`),
    );
    const tokens = new URL(
      response.headers.get("location") ?? "",
      "http://localhost",
    ).searchParams.get("tokens");
    if (tokens === null || tokens === "") {
      throw new Error(`no token redirect for ${sessionId}`);
    }
    return tokens;
  };

  const tokensRequest = (tokens: string): Promise<Response> =>
    handlePaymentSuccess(
      new Request(
        `http://localhost/payment/success?tokens=${encodeURIComponent(tokens)}`,
      ),
    );

  interface Booking {
    readonly items: readonly CheckoutLine[];
    readonly sessionId: string;
  }

  /** Book one checkout per entry, then render the success page from the tokens
   *  its redirects handed out, joined the way a buyer's URL carries them. */
  const renderTokenPage = async (...bookings: readonly Booking[]) => {
    const tokens: string[] = [];
    for (const { sessionId, items } of bookings) {
      tokens.push(await bookToken(sessionId, items));
    }
    const joined = tokens.join("+");
    return { response: await tokensRequest(joined), tokens: joined };
  };

  const lineFor = (listing: { id: number }): CheckoutLine => ({
    e: listing.id,
    p: 500,
    q: 1,
  });

  /** Assert the rendered page links the joined tokens and redirects nowhere,
   *  then hand back the page for any extra wordings a test rules out. */
  const expectTokenLinkWithoutRedirect = async (
    response: Response,
    tokens: string,
  ): Promise<string> => {
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain(`href="/t/${tokens}"`);
    expect(page).not.toContain('http-equiv="refresh"');
    return page;
  };

  test("renders the paid page from a real token", async () => {
    await setupStripe();
    const listing = await paidListing({
      thankYouUrl: "https://example.com/real-thanks",
    });

    const { response, tokens } = await renderTokenPage({
      items: [lineFor(listing)],
      sessionId: "cs_tok_single",
    });

    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('data-payment-result="success"');
    expect(page).toContain(`href="/t/${tokens}"`);
    expect(page).toContain("url=https://example.com/real-thanks");
  });

  test("joins several real tokens into one ticket link", async () => {
    await setupStripe();
    const listing = await paidListing();

    const { response, tokens } = await renderTokenPage(
      { items: [lineFor(listing)], sessionId: "cs_tok_join_a" },
      { items: [lineFor(listing)], sessionId: "cs_tok_join_b" },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`href="/t/${tokens}"`);
  });

  test("shows no thank-you redirect when the tokens span several listings", async () => {
    await setupStripe();
    const boat = await paidListing();
    const hut = await paidListing();

    const { response, tokens } = await renderTokenPage(
      { items: [lineFor(boat)], sessionId: "cs_tok_multi_a" },
      { items: [lineFor(hut)], sessionId: "cs_tok_multi_b" },
    );

    await expectTokenLinkWithoutRedirect(response, tokens);
  });

  test("hides a hidden package member's thank-you URL", async () => {
    await setupStripe();
    const group = await createHiddenPackageGroup("Concealed Pkg");
    const member = await paidListing({
      groupId: group.id,
      thankYouUrl: "https://example.com/concealed-thanks",
    });

    const { response, tokens } = await renderTokenPage({
      items: [{ ...lineFor(member), k: "p", r: group.id }],
      sessionId: "cs_tok_hidden",
    });

    const page = await expectTokenLinkWithoutRedirect(response, tokens);
    expect(page).not.toContain("concealed-thanks");
  });

  test("shows a visible package member's thank-you URL", async () => {
    await setupStripe();
    const group = await createTestGroup({ isPackage: true, name: "Shown Pkg" });
    const member = await paidListing({
      groupId: group.id,
      thankYouUrl: "https://example.com/shown-thanks",
    });

    const { response } = await renderTokenPage({
      items: [{ ...lineFor(member), k: "p", r: group.id }],
      sessionId: "cs_tok_shown",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "url=https://example.com/shown-thanks",
    );
  });

  test("shows no thank-you redirect when the listing has none", async () => {
    await setupStripe();
    const listing = await paidListing({ thankYouUrl: " " });

    const { response, tokens } = await renderTokenPage({
      items: [lineFor(listing)],
      sessionId: "cs_tok_no_thanks",
    });

    await expectTokenLinkWithoutRedirect(response, tokens);
  });

  test("answers 400 when no token names a real booking", async () => {
    await setupStripe();

    const response = await tokensRequest("not-a-token");

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid payment callback");
  });
});
