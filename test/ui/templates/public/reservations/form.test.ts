import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import {
  clearSavedFormData,
  setSavedFormData,
} from "#shared/forms/saved-data.ts";
import { detectIframeMode } from "#shared/iframe.ts";
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
} from "#test/templates/public/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { hasInputWithValue } from "#test-utils/csrf.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

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
    expect(html).toContain('class="listing-image"');
    expect(html).toContain('alt="People at the listing"');
    expect(html).toContain('<div class="prose"><h1>Listing header</h1>');
    expect(html).toContain('<div class="description"><p>First paragraph</p>');
    expect(html).toContain("<p>Second paragraph</p>");
    expect(html).toContain("<strong>Date:</strong> ");
    expect(html).toContain('class="badge-alert"> 2 days ago');
    expect(html).toContain("<strong>Location:</strong> Main hall");
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
    expect(html).toContain('<fieldset class="news-gallery">');
    expect(html).toContain(
      'class="news-gallery-full" src="/image/gallery.webp"',
    );
    expect(html).not.toContain("fallback.webp");
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
    setSavedFormData(new FormParams({ addon_7: "2" }));
    try {
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
      expect(html).toContain('<fieldset class="ticket-addons">');
      expect(html).toContain('<label class="addon-row">');
      expect(html).toContain('<span class="addon-name">T-shirt ');
      expect(html).toContain('<span class="addon-price">(+£5)</span>');
      expect(html).toContain('aria-label="T-shirt — Quantity"');
      expect(html).toContain(
        'max="5" min="0" name="addon_7" placeholder="0" type="number" value="2"',
      );
    } finally {
      clearSavedFormData();
    }
  });

  test("restores the submitted promo code", () => {
    setSavedFormData(new FormParams({ promo_code: "SAVE20" }));
    try {
      const html = singleListingPageHtml({ promoCodesEnabled: true });
      expect(html).toContain('<div class="promo-code"><label>Promo code');
      expect(html).toContain(
        'name="promo_code" placeholder="Optional" type="text" value="SAVE20"',
      );
    } finally {
      clearSavedFormData();
    }
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
    expect(html).toContain(
      'name="qr_token" type="hidden" value="signed-token"',
    );
  });

  test("restores the submitted date before the prefilled date", () => {
    setSavedFormData(new FormParams({ date: "2026-08-02" }));
    try {
      const html = renderForm({
        dates: ["2026-08-01", "2026-08-02"],
        dayCounts: [1, 2],
        hasCustomisable: true,
        hasDaily: true,
        prefill: { date: "2026-08-01", listings: new Map() },
      });
      expect(html).toContain('<option value="2026-08-02" selected>');
      expect(html).not.toContain('<option value="2026-08-01" selected>');
      expect(html).toContain('name="day_count"');
    } finally {
      clearSavedFormData();
    }
    const prefilledHtml = renderForm({
      dates: ["2026-08-01"],
      hasDaily: true,
      prefill: { date: "2026-08-01", listings: new Map() },
    });
    expect(prefilledHtml).toContain('<option value="2026-08-01" selected>');
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
    expect(html).toContain('<div class="running-total">');
    expect(html).toContain('data-running-total formaction="/calculate/ab12c"');
    expect(html).toContain("formnovalidate");
    expect(html).toContain('formtarget="_blank"');
    expect(html).toContain(
      '<output class="order-summary-output" data-running-total-output></output>',
    );
  });

  test("uses an explicit empty action for the current page", () => {
    expect(renderForm({ actionUrl: "" })).toContain('action=""');
  });

  test("omits the running total for a custom action", () => {
    const html = renderForm({ actionUrl: "/renew/signed-token" });
    expect(html).toContain('action="/renew/signed-token"');
    expect(html).not.toContain("data-running-total");
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
    expect(html).not.toContain("ticket-listings");
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
    expect(html).toContain(
      '<form action="/ticket/ab12c+cd34e" autocomplete="off" method="POST">',
    );
    expect(html).toContain(
      '<fieldset class="ticket-listings"><legend>Select Tickets</legend>',
    );
    expect(html).toContain('formaction="/calculate/ab12c+cd34e"');
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

  test("does not group package rows as independent listings", () => {
    const html = renderForm({ isPackage: true });
    expect(html).toContain('data-listing-row="true"');
    expect(html).not.toContain("ticket-listings");
  });
});
