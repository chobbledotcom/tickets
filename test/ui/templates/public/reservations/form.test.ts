import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { detectIframeMode } from "#shared/iframe.ts";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import {
  listingB,
  registerPublicTemplateHooks,
  singleListingPageHtml,
  ticketListing,
} from "#test/templates/public/helpers.ts";
import { hasInputWithValue } from "#test-utils/csrf.ts";

describe("ticketPage — fields & form", () => {
  registerPublicTemplateHooks();

  test("renders markdown paragraphs in terms and conditions", () => {
    const listings = [
      ticketListing({
        attendee_count: 0,
        id: 1,
        name: "Listing A",
        slug: "ab12c",
      }),
    ];
    const html = ticketPage({
      listings,
      slugs: ["ab12c"],
      terms: "Rule one\n\nRule two",
    });
    expect(html).toContain("<p>Rule one</p>");
    expect(html).toContain("<p>Rule two</p>");
    expect(html).toContain('name="agree_terms"');
  });

  test("renders custom questions with listing IDs", () => {
    const listings = [
      ticketListing({
        attendee_count: 0,
        id: 1,
        name: "Listing A",
        slug: "ab12c",
      }),
    ];
    const questions = [
      {
        answers: [
          {
            active: true,
            id: 10,
            question_id: 5,
            sort_order: 0,
            text: "Small",
          },
        ],
        display_type: "radio" as const,
        id: 5,
        text: "Size?",
      },
    ];
    const questionListingMap = new Map([[5, [1]]]);
    const html = ticketPage({
      listings,
      questionListingMap,
      questions,
      slugs: ["ab12c"],
    });
    expect(html).toContain("Size?");
    expect(html).toContain('name="question_5"');
    expect(html).toContain('data-listing-ids="1"');
  });

  test("renders a promo-code field when promo codes are enabled", () => {
    const listings = [
      ticketListing({
        attendee_count: 0,
        id: 1,
        name: "Listing A",
        slug: "ab12c",
      }),
    ];
    const html = ticketPage({
      listings,
      promoCodesEnabled: true,
      slugs: ["ab12c"],
    });
    expect(html).toContain('name="promo_code"');
    expect(html).toContain("Promo code");
  });

  test("omits the promo-code field when promo codes are disabled", () => {
    const html = singleListingPageHtml();
    expect(html).not.toContain('name="promo_code"');
  });

  test("renders an opt-in add-on selector with its price label", () => {
    const listings = [
      ticketListing({
        attendee_count: 0,
        id: 1,
        name: "Listing A",
        slug: "ab12c",
      }),
    ];
    const html = ticketPage({
      addOns: [
        {
          id: 7,
          maxQuantity: 5,
          name: "T-shirt",
          priceLabel: "+£5",
          requiresPayment: true,
        },
      ],
      listings,
      slugs: ["ab12c"],
    });
    expect(html).toContain('name="addon_7"');
    expect(html).toContain("T-shirt");
    expect(html).toContain("+£5");
    expect(html).toContain('max="5"');
  });

  test("appends ?iframe=true to form action in iframe mode", () => {
    detectIframeMode(new URL("https://example.com/?iframe=true"));
    const html = singleListingPageHtml();
    expect(html).toContain('action="/ticket/ab12c?iframe=true"');
    expect(html).toContain('class="iframe"');
    detectIframeMode(new URL("https://example.com/"));
  });

  test("includes iframe-resizer child script in iframe mode", () => {
    detectIframeMode(new URL("https://example.com/?iframe=true"));
    const html = singleListingPageHtml();
    expect(html).toContain("iframe-resizer-child.js");
    detectIframeMode(new URL("https://example.com/"));
  });

  test("excludes iframe-resizer child script without iframe mode", () => {
    const html = singleListingPageHtml();
    expect(html).not.toContain("iframe-resizer-child.js");
  });

  test("does not append ?iframe=true without iframe mode", () => {
    const html = singleListingPageHtml();
    expect(html).toContain('action="/ticket/ab12c"');
    expect(html).not.toContain("?iframe=true");
    expect(html).not.toContain('class="iframe"');
  });

  test("hides quantity selector for single listing with max quantity 1", () => {
    const listings = [
      ticketListing({
        attendee_count: 0,
        id: 1,
        max_quantity: 1,
        name: "Listing A",
        slug: "ab12c",
      }),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c"] });
    expect(hasInputWithValue(html, "quantity_1", "1")).toBe(true);
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Select Tickets");
  });

  test("shows quantity selector for single listing with max quantity above 1", () => {
    const listings = [
      ticketListing({
        attendee_count: 0,
        id: 1,
        max_quantity: 3,
        name: "Listing A",
        slug: "ab12c",
      }),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c"] });
    expect(html).toContain("<select");
    expect(html).toContain('name="quantity_1"');
    expect(html).toContain("Number of Tickets");
    expect(hasInputWithValue(html, "quantity_1", "1")).toBe(false);
  });

  test("shows quantity selector for multiple listings even with max quantity 1", () => {
    const listings = [
      ticketListing({
        attendee_count: 0,
        id: 1,
        max_quantity: 1,
        name: "Listing A",
        slug: "ab12c",
      }),
      ticketListing({
        attendee_count: 0,
        id: 2,
        max_quantity: 1,
        name: "Listing B",
        slug: "cd34e",
      }),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c", "cd34e"] });
    expect(html).toContain("<select");
    expect(html).toContain("Select Tickets");
  });

  test("hides quantity selector when one listing available and one sold out", () => {
    const listings = [
      ticketListing({
        attendee_count: 0,
        id: 1,
        max_quantity: 1,
        name: "Listing A",
        slug: "ab12c",
      }),
      listingB(),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c", "cd34e"] });
    expect(hasInputWithValue(html, "quantity_1", "1")).toBe(true);
    expect(html).not.toContain("Select Tickets");
  });
});
