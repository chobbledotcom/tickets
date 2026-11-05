import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { buildTicketListing } from "#booking/model.ts";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import { getCurrentCsrfToken } from "#shared/csrf.ts";
import { fieldsApi } from "#templates/fields/ticket.ts";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import {
  PKG_SLUG,
  pagePackage,
  registerPublicTemplateHooks,
} from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { hasInputWithValue } from "#test-utils/csrf.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import type { ListingWithCount } from "#types";

describe("ticketPage (single listing)", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  const listing = testListingWithCount({ attendee_count: 50 });
  const renderTicket = async (
    ev: ListingWithCount,
    opts?: {
      error?: string;
      isClosed?: boolean;
      iframe?: boolean;
      dates?: string[];
      terms?: string | null;
      baseUrl?: string;
      questions?: QuestionWithAnswers[];
    },
  ) => {
    const props = {
      ...(opts?.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      dates: opts?.dates ?? [],
      ...(opts?.error !== undefined ? { error: opts.error } : {}),
      listings: [buildTicketListing(ev, opts?.isClosed ?? false, undefined)],
      ...(opts?.questions !== undefined ? { questions: opts.questions } : {}),
      slugs: [ev.slug],
      ...(opts?.terms !== undefined ? { terms: opts.terms } : {}),
    };
    return withRequestContext(() => ticketPage(props), {
      iframe: opts?.iframe ?? false,
    });
  };

  test("renders page title", async () => {
    const html = await renderTicket(listing);
    assertStringIncludes(html, "Test Listing");
  });

  test("renders registration form when spots available", async () => {
    const html = await renderTicket(listing);
    expectIncludesAll(html, [
      'action="/ticket/ab12c"',
      'name="name"',
      'name="email"',
      "Continue",
    ]);
  });

  test("includes CSRF token in form", async () => {
    const html = await renderTicket(listing);
    expectIncludesAll(html, [
      'name="csrf_token"',
      `value="${getCurrentCsrfToken()}"`,
    ]);
  });

  test("shows error when provided", async () => {
    const html = await renderTicket(listing, {
      error: "Name and email are required",
    });
    expectIncludesAll(html, ["Name and email are required", 'class="error"']);
  });

  test("shows full message when no spots", async () => {
    const fullListing = testListingWithCount({ attendee_count: 100 });
    const html = await renderTicket(fullListing);
    assertStringIncludes(html, "this listing is full");
    assert(!html.includes(">Reserve Ticket</button>"));
  });

  test("displays listing name as header", async () => {
    const html = await renderTicket(listing);
    assertStringIncludes(html, "<h1>Test Listing</h1>");
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
      assert(!render().includes('name="email"'));
      assertStringIncludes(render(new Map([[991, 1500]])), 'name="email"');
    } finally {
      s.restore();
    }
  });

  test("shows quantity selector when max_quantity > 1 and spots available", async () => {
    const multiQtyListing = testListingWithCount({
      attendee_count: 0,
      max_quantity: 5,
    });
    const html = await renderTicket(multiQtyListing);
    expectIncludesAll(html, [
      "Number of Tickets",
      `name="quantity_${multiQtyListing.id}"`,
      '<option value="1">1</option>',
      '<option value="5">5</option>',
      "Continue",
    ]);
  });

  test("limits quantity selector to remaining spots", async () => {
    const limitedListing = testListingWithCount({
      attendee_count: 97, // Only 3 spots remaining
      max_quantity: 10,
    });
    const html = await renderTicket(limitedListing);
    expectIncludesAll(html, [
      "Number of Tickets",
      '<option value="3">3</option>',
    ]);
    assert(!html.includes('<option value="4">4</option>'));
  });

  test("a built-site plan sells months, not tickets", async () => {
    const planListing = testListingWithCount({
      assign_built_site: true,
      attendee_count: 0,
      initial_site_months: 3,
      max_quantity: 5,
    });
    const html = await renderTicket(planListing);
    expectIncludesAll(html, [
      "Number of months",
      // Each option states the months it buys: three units of a three-month
      // plan are nine months.
      '<option value="1">3 months</option>',
      '<option value="3">9 months</option>',
    ]);
    assert(!html.includes("Number of Tickets"));
    assert(!html.includes('">3</option>'));
  });

  test("hides quantity selector when max_quantity is 1", async () => {
    const html = await renderTicket(listing); // max_quantity is 1
    assert(!html.includes("Number of Tickets"));
    expect(hasInputWithValue(html, `quantity_${listing.id}`, "1")).toBe(true);
    assertStringIncludes(html, "Continue");
  });

  test("shows Continue button for purchase_only listing", async () => {
    const poListing = testListingWithCount({
      attendee_count: 50,
      purchase_only: true,
    });
    const html = await renderTicket(poListing);
    assertStringIncludes(html, "Continue");
  });

  test("shows phone field for phone-only listings", async () => {
    const phoneListing = testListingWithCount({
      attendee_count: 50,
      fields: "phone",
    });
    const html = await renderTicket(phoneListing);
    expectIncludesAll(html, ['name="phone"', "Your Phone Number"]);
    assert(!html.includes('name="email"'));
  });

  test("shows both email and phone for email,phone setting", async () => {
    const bothListing = testListingWithCount({
      attendee_count: 50,
      fields: "email,phone",
    });
    const html = await renderTicket(bothListing);
    expectIncludesAll(html, ['name="email"', 'name="phone"']);
  });

  test("shows only email for email setting", async () => {
    const html = await renderTicket(listing);
    assertStringIncludes(html, 'name="email"');
    assert(!html.includes('name="phone"'));
  });

  test("hides header and description in iframe mode", async () => {
    const listingWithDesc = testListingWithCount({
      attendee_count: 50,
      description: "A great listing",
    });
    const html = await renderTicket(listingWithDesc, { iframe: true });
    assert(!html.includes("<h1>"));
    assert(!html.includes("A great listing"));
    expectIncludesAll(html, ['class="iframe"', 'name="name"']);
  });

  test("shows header and description when not in iframe mode", async () => {
    const listingWithDesc = testListingWithCount({
      attendee_count: 50,
      description: "A great listing",
    });
    const html = await renderTicket(listingWithDesc);
    expectIncludesAll(html, ["<h1>Test Listing</h1>", "A great listing"]);
    assert(!html.includes('class="iframe"'));
  });

  test("includes iframe-resizer child script in iframe mode", async () => {
    const html = await renderTicket(listing, { iframe: true });
    assertStringIncludes(html, "iframe-resizer-child.js");
  });

  test("excludes iframe-resizer child script when not in iframe mode", async () => {
    const html = await renderTicket(listing);
    assert(!html.includes("iframe-resizer-child.js"));
  });

  test("renders terms and conditions with checkbox", async () => {
    const html = await renderTicket(listing, { terms: "No refunds allowed" });
    expectIncludesAll(html, [
      "No refunds allowed",
      'class="prose"',
      'name="agree_terms"',
    ]);
  });

  test("renders markdown paragraphs in terms and conditions", async () => {
    const html = await renderTicket(listing, {
      terms: "Line one\n\nLine two\n\nLine three",
    });
    expectIncludesAll(html, [
      "<p>Line one</p>",
      "<p>Line two</p>",
      "<p>Line three</p>",
    ]);
  });

  test("does not render terms when not provided", async () => {
    const html = await renderTicket(listing);
    assert(!html.includes('class="terms"'));
    assert(!html.includes('name="agree_terms"'));
  });

  test("renders custom questions when provided", async () => {
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
        assign_all: false,
        display_type: "radio" as const,
        id: 1,
        text: "Size?",
      },
    ];
    const html = await renderTicket(listing, { questions });
    expectIncludesAll(html, ["Size?", 'name="question_1"']);
  });

  test("includes OpenGraph tags when baseUrl is provided", async () => {
    const ev = testListingWithCount({
      description: "A fun party",
      name: "Birthday Party",
      slug: "birthday-party",
    });
    const html = await renderTicket(ev, {
      baseUrl: "https://tix.example.com",
    });
    expectIncludesAll(html, [
      '<meta property="og:title" content="Birthday Party">',
      '<meta property="og:type" content="website">',
      '<meta property="og:url" content="https://tix.example.com/ticket/birthday-party">',
      '<meta property="og:description" content="A fun party">',
    ]);
  });

  test("does not include OpenGraph tags when baseUrl is not provided", async () => {
    const html = await renderTicket(listing);
    assert(!html.includes("og:title"));
  });
});
