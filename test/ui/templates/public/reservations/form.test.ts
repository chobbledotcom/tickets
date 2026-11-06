import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import {
  clearSavedFormData,
  setSavedFormData,
} from "#shared/forms/saved-data.ts";
import { detectIframeMode } from "#shared/request-context.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import {
  TicketPageForm,
  TicketPageHeader,
} from "#templates/public/reservations/form.tsx";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import {
  listingB,
  registerPublicTemplateHooks,
  singleListingPageHtml,
  ticketListing,
} from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { hasInputWithValue } from "#test-utils/csrf.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

const renderForm = (
  overrides: Partial<Parameters<typeof TicketPageForm>[0]> = {},
): string =>
  String(
    TicketPageForm({
      addOns: undefined,
      dates: undefined,
      dayCounts: [],
      durationDays: 1,
      fields: [],
      hasCustomisable: false,
      hasDaily: false,
      hideQuantity: false,
      isPackage: false,
      isSingleListing: false,
      listingRows: '<p data-listing-row="true">Listing row</p>',
      promoCodesEnabled: false,
      questionListingMap: undefined,
      questions: undefined,
      slugs: ["ab12c"],
      terms: undefined,
      ...overrides,
    }),
  );

const renderHeader = (
  overrides: Partial<Parameters<typeof TicketPageHeader>[0]> = {},
): string =>
  String(
    TicketPageHeader({
      galleryImages: [],
      headerDescription: null,
      headerImage: null,
      headerName: "Listing header",
      listingAttributes: undefined,
      pastDays: null,
      singleListing: null,
      ...overrides,
    }),
  );

describe("ticketPage — fields & form", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("renders the listing header details and fallback image", () => {
    const html = renderHeader({
      headerDescription: "First paragraph\n\nSecond paragraph",
      headerImage: {
        image_alt_text: "People at the listing",
        image_thumb_url: "listing-thumb.webp",
        image_url: "listing.webp",
      },
      pastDays: 2,
      singleListing: testListingWithCount({
        date: "2026-07-20T12:00:00.000Z",
        location: "Main hall",
      }),
    });
    expectIncludesAll(html, [
      'class="listing-image"',
      'alt="People at the listing"',
      '<div class="prose"><h1>Listing header</h1>',
      '<div class="description"><p>First paragraph</p>',
      "<p>Second paragraph</p>",
      "<strong>Date:</strong> ",
      'class="badge-alert"> 2 days ago',
      "<strong>Location:</strong> Main hall",
    ]);
  });

  test("uses gallery images instead of the fallback header image", () => {
    const html = renderHeader({
      galleryImages: [
        {
          alt_text: "Gallery view",
          filename: nonEmptyString("gallery.webp"),
          filename_thumb: nonEmptyString("gallery-thumb.webp"),
          id: 9,
          name: "Gallery image",
        },
      ],
      headerImage: {
        image_alt_text: "Fallback view",
        image_thumb_url: "fallback-thumb.webp",
        image_url: "fallback.webp",
      },
    });
    expectIncludesAll(html, [
      '<fieldset class="news-gallery">',
      'class="news-gallery-full" src="/image/gallery.webp"',
    ]);
    assert(!html.includes("fallback.webp"));
  });

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
    expectIncludesAll(html, [
      "<p>Rule one</p>",
      "<p>Rule two</p>",
      'name="agree_terms"',
    ]);
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
            id: 51,
            question_id: 5,
            sort_order: 0,
            text: "Small",
          },
        ],
        assign_all: false,
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
    expectIncludesAll(html, [
      "Size?",
      'name="question_5"',
      'data-listing-ids="1"',
    ]);
  });

  test("renders an opt-in add-on selector with its price label", async () => {
    const listings = [
      ticketListing({
        attendee_count: 0,
        id: 1,
        name: "Listing A",
        slug: "ab12c",
      }),
    ];
    await withRequestContext(() => {
      setSavedFormData(new FormParams({ addon_7: "2" }));
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
      expectIncludesAll(html, [
        '<fieldset class="ticket-addons">',
        '<label class="addon-row">',
        '<span class="addon-name">T-shirt ',
        '<span class="addon-price">(+£5)</span>',
        'aria-label="T-shirt — Quantity"',
        'max="5" min="0" name="addon_7" placeholder="0" type="number" value="2"',
      ]);
    });
  });

  test("prefills the name and signed token", () => {
    const html = renderForm({
      fields: [{ label: "Name", name: "name", type: "text" }],
      prefill: {
        listings: new Map(),
        name: "Ada Lovelace",
        token: "signed-token",
      },
    });
    expect(hasInputWithValue(html, "name", "Ada Lovelace")).toBe(true);
    assertStringIncludes(
      html,
      'name="qr_token" type="hidden" value="signed-token"',
    );
  });

  test("restores the submitted date before the prefilled date", async () => {
    await withRequestContext(() => {
      setSavedFormData(new FormParams({ date: "2026-08-02" }));
      const html = renderForm({
        dates: ["2026-08-01", "2026-08-02"],
        dayCounts: [1, 2],
        hasCustomisable: true,
        hasDaily: true,
        prefill: { date: "2026-08-01", listings: new Map() },
      });
      assertStringIncludes(html, '<option value="2026-08-02" selected>');
      assert(!html.includes('<option value="2026-08-01" selected>'));
      assertStringIncludes(html, 'name="day_count"');
      clearSavedFormData();
      const prefilledHtml = renderForm({
        dates: ["2026-08-01"],
        hasDaily: true,
        prefill: { date: "2026-08-01", listings: new Map() },
      });
      assertStringIncludes(
        prefilledHtml,
        '<option value="2026-08-01" selected>',
      );
    });
  });

  test("appends ?iframe=true to form action in iframe mode", async () => {
    await withRequestContext(() => {
      detectIframeMode(new URL("https://example.com/?iframe=true"));
      const html = singleListingPageHtml();
      expectIncludesAll(html, [
        'action="/ticket/ab12c?iframe=true"',
        'class="iframe"',
      ]);
    });
  });

  test("includes iframe-resizer child script in iframe mode", async () => {
    await withRequestContext(() => {
      detectIframeMode(new URL("https://example.com/?iframe=true"));
      const html = singleListingPageHtml();
      assertStringIncludes(html, "iframe-resizer-child.js");
    });
  });

  test("excludes iframe-resizer child script without iframe mode", () => {
    const html = singleListingPageHtml();
    assert(!html.includes("iframe-resizer-child.js"));
  });

  test("does not append ?iframe=true without iframe mode", () => {
    const html = singleListingPageHtml();
    assertStringIncludes(html, 'action="/ticket/ab12c"');
    assert(!html.includes("?iframe=true"));
    assert(!html.includes('class="iframe"'));
    expectIncludesAll(html, [
      '<div class="running-total">',
      'data-running-total formaction="/calculate/ab12c"',
      "formnovalidate",
      'formtarget="_blank"',
      '<output class="order-summary-output" data-running-total-output></output>',
    ]);
  });

  test("uses an explicit empty action for the current page", () => {
    assertStringIncludes(renderForm({ actionUrl: "" }), 'action=""');
  });

  test("omits the running total for a custom action", () => {
    const html = renderForm({ actionUrl: "/renew/signed-token" });
    assertStringIncludes(html, 'action="/renew/signed-token"');
    assert(!html.includes("data-running-total"));
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
    assert(!html.includes("<select"));
    assert(!html.includes("Select Tickets"));
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
    expectIncludesAll(html, [
      "<select",
      'name="quantity_1"',
      "Number of Tickets",
    ]);
    expect(hasInputWithValue(html, "quantity_1", "1")).toBe(false);
    assert(!html.includes("ticket-listings"));
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
    expectIncludesAll(html, [
      "<select",
      '<form action="/ticket/ab12c+cd34e" autocomplete="off" method="POST">',
      '<fieldset class="ticket-listings"><legend>Select Tickets</legend>',
      'formaction="/calculate/ab12c+cd34e"',
    ]);
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
    assert(!html.includes("Select Tickets"));
  });

  test("does not group package rows as independent listings", () => {
    const html = renderForm({ isPackage: true });
    assertStringIncludes(html, 'data-listing-row="true"');
    assert(!html.includes("ticket-listings"));
  });
});
