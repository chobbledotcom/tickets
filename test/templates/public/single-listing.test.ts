import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { buildTicketListing } from "#shared/booking/model.ts";
import { getCurrentCsrfToken } from "#shared/csrf.ts";
import { detectIframeMode } from "#shared/iframe.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { fieldsApi } from "#templates/fields/ticket.ts";
import { ticketPage } from "#templates/public/reservations.tsx";
import { hasInputWithValue, testListingWithCount } from "#test-utils";
import {
  PKG_SLUG,
  pagePackage,
  registerPublicTemplateHooks,
} from "./helpers.ts";

registerPublicTemplateHooks();

describe("ticketPage (single listing)", () => {
  const listing = testListingWithCount({ attendee_count: 50 });
  const renderTicket = (
    ev: ListingWithCount,
    opts?: {
      error?: string;
      isClosed?: boolean;
      iframe?: boolean;
      dates?: string[];
      terms?: string | null;
      baseUrl?: string;
      questions?: {
        display_type: "radio" | "select";
        id: number;
        text: string;
        answers: {
          active: boolean;
          id: number;
          question_id: number;
          text: string;
          sort_order: number;
        }[];
      }[];
    },
  ) => {
    if (opts?.iframe) detectIframeMode("https://example.com/?iframe=true");
    else detectIframeMode("https://example.com/");
    return ticketPage({
      ...(opts?.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      dates: opts?.dates ?? [],
      ...(opts?.error !== undefined ? { error: opts.error } : {}),
      listings: [buildTicketListing(ev, opts?.isClosed ?? false, undefined)],
      ...(opts?.questions !== undefined ? { questions: opts.questions } : {}),
      slugs: [ev.slug],
      ...(opts?.terms !== undefined ? { terms: opts.terms } : {}),
    });
  };

  test("renders page title", () => {
    const html = renderTicket(listing);
    expect(html).toContain("Test Listing");
  });

  test("renders registration form when spots available", () => {
    const html = renderTicket(listing);
    expect(html).toContain('action="/ticket/ab12c"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="email"');
    expect(html).toContain("Continue");
  });

  test("includes CSRF token in form", () => {
    const html = renderTicket(listing);
    expect(html).toContain('name="csrf_token"');
    expect(html).toContain(`value="${getCurrentCsrfToken()}"`);
  });

  test("shows error when provided", () => {
    const html = renderTicket(listing, {
      error: "Name and email are required",
    });
    expect(html).toContain("Name and email are required");
    expect(html).toContain('class="error"');
  });

  test("shows full message when no spots", () => {
    const fullListing = testListingWithCount({ attendee_count: 100 });
    const html = renderTicket(fullListing);
    expect(html).toContain("this listing is full");
    expect(html).not.toContain(">Reserve Ticket</button>");
  });

  test("displays listing name as header", () => {
    const html = renderTicket(listing);
    expect(html).toContain("<h1>Test Listing</h1>");
  });

  test("a package override makes an otherwise-free listing render the provider email", () => {
    // Square requires an email for paid checkouts; a free listing whose only
    // cost comes from a package override must still surface that field.
    const s = stub(fieldsApi, "getSettingCached", () => "square");
    try {
      const free = testListingWithCount({
        attendee_count: 0,
        fields: "",
        id: 991,
        slug: "free991",
        unit_price: 0,
      });
      const render = (packagePrices?: ReadonlyMap<number, number>) =>
        ticketPage({
          dates: [],
          listings: [buildTicketListing(free, false, undefined)],
          ...(packagePrices
            ? { packages: [pagePackage(5, [991], { prices: packagePrices })] }
            : {}),
          slugs: [PKG_SLUG],
        });
      expect(render()).not.toContain('name="email"');
      expect(render(new Map([[991, 1500]]))).toContain('name="email"');
    } finally {
      s.restore();
    }
  });

  test("shows quantity selector when max_quantity > 1 and spots available", () => {
    const multiQtyListing = testListingWithCount({
      attendee_count: 0,
      max_quantity: 5,
    });
    const html = renderTicket(multiQtyListing);
    expect(html).toContain("Number of Tickets");
    expect(html).toContain(`name="quantity_${multiQtyListing.id}"`);
    expect(html).toContain('<option value="1">1</option>');
    expect(html).toContain('<option value="5">5</option>');
    expect(html).toContain("Continue");
  });

  test("limits quantity selector to remaining spots", () => {
    const limitedListing = testListingWithCount({
      attendee_count: 97, // Only 3 spots remaining
      max_quantity: 10,
    });
    const html = renderTicket(limitedListing);
    expect(html).toContain("Number of Tickets");
    expect(html).toContain('<option value="3">3</option>');
    expect(html).not.toContain('<option value="4">4</option>');
  });

  test("hides quantity selector when max_quantity is 1", () => {
    const html = renderTicket(listing); // max_quantity is 1
    expect(html).not.toContain("Number of Tickets");
    expect(hasInputWithValue(html, `quantity_${listing.id}`, "1")).toBe(true);
    expect(html).toContain("Continue");
  });

  test("shows Continue button for purchase_only listing", () => {
    const poListing = testListingWithCount({
      attendee_count: 50,
      purchase_only: true,
    });
    const html = renderTicket(poListing);
    expect(html).toContain("Continue");
  });

  test("shows phone field for phone-only listings", () => {
    const phoneListing = testListingWithCount({
      attendee_count: 50,
      fields: "phone",
    });
    const html = renderTicket(phoneListing);
    expect(html).toContain('name="phone"');
    expect(html).toContain("Your Phone Number");
    expect(html).not.toContain('name="email"');
  });

  test("shows both email and phone for email,phone setting", () => {
    const bothListing = testListingWithCount({
      attendee_count: 50,
      fields: "email,phone",
    });
    const html = renderTicket(bothListing);
    expect(html).toContain('name="email"');
    expect(html).toContain('name="phone"');
  });

  test("shows only email for email setting", () => {
    const html = renderTicket(listing);
    expect(html).toContain('name="email"');
    expect(html).not.toContain('name="phone"');
  });

  test("hides header and description in iframe mode", () => {
    const listingWithDesc = testListingWithCount({
      attendee_count: 50,
      description: "A great listing",
    });
    const html = renderTicket(listingWithDesc, { iframe: true });
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("A great listing");
    expect(html).toContain('class="iframe"');
    expect(html).toContain('name="name"');
  });

  test("shows header and description when not in iframe mode", () => {
    const listingWithDesc = testListingWithCount({
      attendee_count: 50,
      description: "A great listing",
    });
    const html = renderTicket(listingWithDesc);
    expect(html).toContain("<h1>Test Listing</h1>");
    expect(html).toContain("A great listing");
    expect(html).not.toContain('class="iframe"');
  });

  test("includes iframe-resizer child script in iframe mode", () => {
    const html = renderTicket(listing, { iframe: true });
    expect(html).toContain("iframe-resizer-child.js");
  });

  test("excludes iframe-resizer child script when not in iframe mode", () => {
    const html = renderTicket(listing);
    expect(html).not.toContain("iframe-resizer-child.js");
  });

  test("renders terms and conditions with checkbox", () => {
    const html = renderTicket(listing, { terms: "No refunds allowed" });
    expect(html).toContain("No refunds allowed");
    expect(html).toContain('class="prose"');
    expect(html).toContain('name="agree_terms"');
  });

  test("renders markdown paragraphs in terms and conditions", () => {
    const html = renderTicket(listing, {
      terms: "Line one\n\nLine two\n\nLine three",
    });
    expect(html).toContain("<p>Line one</p>");
    expect(html).toContain("<p>Line two</p>");
    expect(html).toContain("<p>Line three</p>");
  });

  test("does not render terms when not provided", () => {
    const html = renderTicket(listing);
    expect(html).not.toContain('class="terms"');
    expect(html).not.toContain('name="agree_terms"');
  });

  test("renders custom questions when provided", () => {
    const questions = [
      {
        answers: [
          {
            active: true,
            id: 10,
            question_id: 1,
            sort_order: 0,
            text: "Small",
          },
          {
            active: true,
            id: 11,
            question_id: 1,
            sort_order: 1,
            text: "Large",
          },
        ],
        display_type: "radio" as const,
        id: 1,
        text: "Size?",
      },
    ];
    const html = renderTicket(listing, { questions });
    expect(html).toContain("Size?");
    expect(html).toContain('name="question_1"');
  });

  test("includes OpenGraph tags when baseUrl is provided", () => {
    const ev = testListingWithCount({
      description: "A fun party",
      name: "Birthday Party",
      slug: "birthday-party",
    });
    const html = renderTicket(ev, {
      baseUrl: "https://tix.example.com",
    });
    expect(html).toContain(
      '<meta property="og:title" content="Birthday Party">',
    );
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain(
      '<meta property="og:url" content="https://tix.example.com/ticket/birthday-party">',
    );
    expect(html).toContain(
      '<meta property="og:description" content="A fun party">',
    );
  });

  test("does not include OpenGraph tags when baseUrl is not provided", () => {
    const html = renderTicket(listing);
    expect(html).not.toContain("og:title");
  });
});
