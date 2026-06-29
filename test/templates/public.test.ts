import { expect } from "@std/expect";
import { afterEach, beforeAll, describe, it as test } from "@std/testing/bdd";
import { getCurrentCsrfToken, signCsrfToken } from "#shared/csrf.ts";
import { addDays } from "#shared/dates.ts";
import { settings } from "#shared/db/settings.ts";
import { detectIframeMode } from "#shared/iframe.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { ListingWithCount } from "#shared/types.ts";
import {
  buildOgTags,
  buildTicketListing,
  migrationInProgressPage,
  notFoundPage,
  renderListingImage,
  siteNotActivatedPage,
  temporaryErrorPage,
  ticketPage,
} from "#templates/public.tsx";
import { ticketViewPage } from "#templates/tickets.tsx";
import {
  describeWithEnv,
  hasInputWithValue,
  setupTestEncryptionKey,
  testAttendee,
  testListingWithCount,
} from "#test-utils";

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

afterEach(() => {
  detectIframeMode("https://example.com/");
});

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

describe("buildOgTags", () => {
  test("includes title, type, and url", () => {
    const html = buildOgTags(
      {
        description: "",
        image_url: "",
        name: "My Listing",
        slug: "my-listing",
      },
      "https://example.com",
    );
    expect(html).toContain('<meta property="og:title" content="My Listing">');
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain(
      '<meta property="og:url" content="https://example.com/ticket/my-listing">',
    );
  });

  test("includes description when present", () => {
    const html = buildOgTags(
      {
        description: "Come join us",
        image_url: "",
        name: "My Listing",
        slug: "my-listing",
      },
      "https://example.com",
    );
    expect(html).toContain(
      '<meta property="og:description" content="Come join us">',
    );
  });

  test("excludes description when empty", () => {
    const html = buildOgTags(
      {
        description: "",
        image_url: "",
        name: "My Listing",
        slug: "my-listing",
      },
      "https://example.com",
    );
    expect(html).not.toContain("og:description");
  });

  test("includes image when present", () => {
    const html = buildOgTags(
      {
        description: "",
        image_url: "photo.jpg",
        name: "My Listing",
        slug: "my-listing",
      },
      "https://example.com",
    );
    expect(html).toContain(
      '<meta property="og:image" content="https://example.com/image/photo.jpg">',
    );
  });

  test("excludes image when empty", () => {
    const html = buildOgTags(
      {
        description: "",
        image_url: "",
        name: "My Listing",
        slug: "my-listing",
      },
      "https://example.com",
    );
    expect(html).not.toContain("og:image");
  });

  test("escapes HTML in listing name", () => {
    const html = buildOgTags(
      {
        description: "",
        image_url: "",
        name: 'Listing "with quotes"',
        slug: "my-listing",
      },
      "https://example.com",
    );
    expect(html).toContain("Listing &quot;with quotes&quot;");
    expect(html).not.toContain('content="Listing "with quotes""');
  });
});

describe("notFoundPage", () => {
  test("renders not found message", () => {
    const html = notFoundPage();
    expect(html).toContain("<h1>Not Found</h1>");
  });
});

describe("temporaryErrorPage", () => {
  test("renders error message with auto-refresh", () => {
    const html = temporaryErrorPage();
    expect(html).toContain("<h1>Temporary Error</h1>");
    expect(html).toContain("Retrying automatically");
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain('content="2"');
    expect(html).toContain("<style>");
    expect(html).toContain("font-family:system-ui");
  });
});

describe("migrationInProgressPage", () => {
  test("renders update message with auto-refresh", () => {
    const html = migrationInProgressPage();
    expect(html).toContain("<h1>Update In Progress</h1>");
    expect(html).toContain("backing up and updating the database");
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain('content="5"');
    expect(html).toContain("<style>");
    expect(html).toContain("font-family:system-ui");
  });

  test("does not present itself as an error", () => {
    const html = migrationInProgressPage();
    expect(html).not.toContain("Error");
  });
});

describe("siteNotActivatedPage", () => {
  test("renders not-activated message in the error dialog style", () => {
    const html = siteNotActivatedPage();
    expect(html).toContain(
      '<div class="prose"><h1>Not Activated</h1><p>This site has not been activated yet.</p></div>',
    );
    expect(html).toContain("<style>");
    expect(html).toContain("font-family:system-ui");
  });

  test("does not auto-refresh", () => {
    const html = siteNotActivatedPage();
    expect(html).not.toContain('http-equiv="refresh"');
  });
});

describe("ticketPage", () => {
  test("shows all sold out message when every listing is sold out", () => {
    const listings = [
      buildTicketListing(
        testListingWithCount({
          attendee_count: 100,
          id: 1,
          max_attendees: 100,
          name: "Listing A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
      buildTicketListing(
        testListingWithCount({
          attendee_count: 50,
          id: 2,
          max_attendees: 50,
          name: "Listing B",
          slug: "cd34e",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c", "cd34e"] });
    expect(html).toContain("Sorry, all listings are sold out.");
    expect(html).not.toContain("Reserve Tickets</button>");
  });

  test("renders markdown paragraphs in terms and conditions", () => {
    const listings = [
      buildTicketListing(
        testListingWithCount({
          attendee_count: 0,
          id: 1,
          name: "Listing A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
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
      buildTicketListing(
        testListingWithCount({
          attendee_count: 0,
          id: 1,
          name: "Listing A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
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
      buildTicketListing(
        testListingWithCount({
          attendee_count: 0,
          id: 1,
          name: "Listing A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
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
    const listings = [
      buildTicketListing(
        testListingWithCount({
          attendee_count: 0,
          id: 1,
          name: "Listing A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c"] });
    expect(html).not.toContain('name="promo_code"');
  });

  test("renders an opt-in add-on selector with its price label", () => {
    const listings = [
      buildTicketListing(
        testListingWithCount({
          attendee_count: 0,
          id: 1,
          name: "Listing A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
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
    detectIframeMode("https://example.com/?iframe=true");
    const listings = [
      buildTicketListing(
        testListingWithCount({
          attendee_count: 0,
          id: 1,
          name: "Listing A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c"] });
    expect(html).toContain('action="/ticket/ab12c?iframe=true"');
    expect(html).toContain('class="iframe"');
    detectIframeMode("https://example.com/");
  });

  test("includes iframe-resizer child script in iframe mode", () => {
    detectIframeMode("https://example.com/?iframe=true");
    const listings = [
      buildTicketListing(
        testListingWithCount({
          attendee_count: 0,
          id: 1,
          name: "Listing A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c"] });
    expect(html).toContain("iframe-resizer-child.js");
    detectIframeMode("https://example.com/");
  });

  test("excludes iframe-resizer child script without iframe mode", () => {
    const listings = [
      buildTicketListing(
        testListingWithCount({
          attendee_count: 0,
          id: 1,
          name: "Listing A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c"] });
    expect(html).not.toContain("iframe-resizer-child.js");
  });

  test("does not append ?iframe=true without iframe mode", () => {
    const listings = [
      buildTicketListing(
        testListingWithCount({
          attendee_count: 0,
          id: 1,
          name: "Listing A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c"] });
    expect(html).toContain('action="/ticket/ab12c"');
    expect(html).not.toContain("?iframe=true");
    expect(html).not.toContain('class="iframe"');
  });

  test("hides quantity selector for single listing with max quantity 1", () => {
    const listings = [
      buildTicketListing(
        testListingWithCount({
          attendee_count: 0,
          id: 1,
          max_quantity: 1,
          name: "Listing A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c"] });
    expect(hasInputWithValue(html, "quantity_1", "1")).toBe(true);
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Select Tickets");
  });

  test("shows quantity selector for single listing with max quantity above 1", () => {
    const listings = [
      buildTicketListing(
        testListingWithCount({
          attendee_count: 0,
          id: 1,
          max_quantity: 3,
          name: "Listing A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c"] });
    expect(html).toContain("<select");
    expect(html).toContain('name="quantity_1"');
    expect(html).toContain("Number of Tickets");
    expect(hasInputWithValue(html, "quantity_1", "1")).toBe(false);
  });

  test("shows quantity selector for multiple listings even with max quantity 1", () => {
    const listings = [
      buildTicketListing(
        testListingWithCount({
          attendee_count: 0,
          id: 1,
          max_quantity: 1,
          name: "Listing A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
      buildTicketListing(
        testListingWithCount({
          attendee_count: 0,
          id: 2,
          max_quantity: 1,
          name: "Listing B",
          slug: "cd34e",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c", "cd34e"] });
    expect(html).toContain("<select");
    expect(html).toContain("Select Tickets");
  });

  test("hides quantity selector when one listing available and one sold out", () => {
    const listings = [
      buildTicketListing(
        testListingWithCount({
          attendee_count: 0,
          id: 1,
          max_quantity: 1,
          name: "Listing A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
      buildTicketListing(
        testListingWithCount({
          attendee_count: 50,
          id: 2,
          max_attendees: 50,
          name: "Listing B",
          slug: "cd34e",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c", "cd34e"] });
    expect(hasInputWithValue(html, "quantity_1", "1")).toBe(true);
    expect(html).not.toContain("Select Tickets");
  });
});

describe("ticketPage listing date and location", () => {
  const renderTicket = (ev: ListingWithCount, opts?: { iframe?: boolean }) => {
    if (opts?.iframe) detectIframeMode("https://example.com/?iframe=true");
    else detectIframeMode("https://example.com/");
    return ticketPage({
      dates: [],
      listings: [buildTicketListing(ev, false, undefined)],
      slugs: [ev.slug],
    });
  };

  test("shows date on public ticket page when listing has date", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
    });
    const html = renderTicket(listing);
    expect(html).toContain("<strong>Date:</strong>");
    expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
  });

  test("does not show date on public ticket page when date is empty", () => {
    const listing = testListingWithCount({ attendee_count: 0, date: "" });
    const html = renderTicket(listing);
    expect(html).not.toContain("<strong>Date:</strong>");
  });

  test("shows location on public ticket page when listing has location", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      location: "Village Hall",
    });
    const html = renderTicket(listing);
    expect(html).toContain("<strong>Location:</strong>");
    expect(html).toContain("Village Hall");
  });

  test("does not show location on public ticket page when location is empty", () => {
    const listing = testListingWithCount({ attendee_count: 0, location: "" });
    const html = renderTicket(listing);
    expect(html).not.toContain("<strong>Location:</strong>");
  });

  test("hides date and location in iframe mode", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
      location: "Village Hall",
    });
    const html = renderTicket(listing, { iframe: true });
    expect(html).not.toContain("<strong>Date:</strong>");
    expect(html).not.toContain("<strong>Location:</strong>");
  });

  test("shows past listing badge for listing with date in the past", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      date: "2020-01-15T14:00:00.000Z",
    });
    const html = renderTicket(listing);
    expect(html).toContain("badge-alert");
    expect(html).toContain("ago");
  });

  test("does not show past listing badge for future listing", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      date: "2099-06-15T14:00:00.000Z",
    });
    const html = renderTicket(listing);
    expect(html).not.toContain("badge-alert");
  });

  test("does not show past listing badge when date is empty", () => {
    const listing = testListingWithCount({ attendee_count: 0, date: "" });
    const html = renderTicket(listing);
    expect(html).not.toContain("badge-alert");
  });

  test("past listing badge shows singular day for 1 day ago", () => {
    const yesterday = addDays(todayInTz(settings.timezone), -1);
    const listing = testListingWithCount({
      attendee_count: 0,
      date: `${yesterday}T12:00:00.000Z`,
    });
    const html = renderTicket(listing);
    expect(html).toContain("1 day ago");
    expect(html).not.toContain("(1 day ago)");
  });

  test("past listing badge shows plural days for multiple days ago", () => {
    const threeDaysAgo = addDays(todayInTz(settings.timezone), -3);
    const listing = testListingWithCount({
      attendee_count: 0,
      date: `${threeDaysAgo}T12:00:00.000Z`,
    });
    const html = renderTicket(listing);
    expect(html).toContain("3 days ago");
    expect(html).not.toContain("(3 days ago)");
  });
});

describe("ticketViewPage listing date and location", () => {
  const token = "AABB0011CCDDEEFF";

  test("shows listing date when entry has non-empty listing date", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({ date: "2026-06-15T14:00:00.000Z" }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
  });

  test("does not show listing date when listing has empty date", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({ date: "" }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).not.toContain("ticket-card-date");
  });

  test("shows a single booking date for a one-day daily booking", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee({ date: "2026-06-15" }),
          listing: testListingWithCount({
            duration_days: 1,
            listing_type: "daily",
          }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    // Duration 1 → a single day, not a range.
    expect(html).toContain("Booking Date: Monday 15 June 2026");
    expect(html).not.toContain("15–");
  });

  test("shows location when entry has non-empty location", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({ location: "Village Hall" }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("Village Hall");
  });

  test("does not show location when listing has empty location", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({ location: "" }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).not.toContain("ticket-card-location");
  });

  test("shows both listing date and location when both are present", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({
            date: "2026-06-15T14:00:00.000Z",
            location: "Town Centre",
          }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
    expect(html).toContain("Town Centre");
  });

  test("shows each ticket as separate card with SVG endpoint reference", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee({ id: 1 }),
          listing: testListingWithCount({
            date: "2026-06-15T14:00:00.000Z",
            id: 1,
          }),
        },
        token: "AABB0011CCDDEEF1",
      },
      {
        entry: {
          attendee: testAttendee({ id: 2 }),
          listing: testListingWithCount({ date: "", id: 2 }),
        },
        token: "AABB0011CCDDEEF2",
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("/t/AABB0011CCDDEEF1/svg");
    expect(html).toContain("/t/AABB0011CCDDEEF2/svg");
    expect(html).toContain("2 Tickets");
  });

  test("hides QR code and token for purchase_only listings", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({ purchase_only: true }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).not.toContain("ticket-card-qr");
    expect(html).not.toContain("ticket-card-token");
    expect(html).not.toContain("/svg");
  });

  test("hides wallet links for purchase_only listings", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({ purchase_only: true }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards, true, true);
    expect(html).not.toContain("wallet-link");
    expect(html).not.toContain("Apple Wallet");
    expect(html).not.toContain("Google Wallet");
  });

  test("hides non-transferable notice for purchase_only listings", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({
            non_transferable: true,
            purchase_only: true,
          }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).not.toContain("Non-transferable");
  });

  test("shows Your Purchase heading for purchase_only listings", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          listing: testListingWithCount({ purchase_only: true }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("Your Purchase");
    expect(html).not.toContain("Ticket");
  });

  test("shows ticket count heading for mixed listings", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee({ id: 1 }),
          listing: testListingWithCount({ id: 1, purchase_only: true }),
        },
        token: "AABB0011CCDDEEF1",
      },
      {
        entry: {
          attendee: testAttendee({ id: 2 }),
          listing: testListingWithCount({ id: 2, purchase_only: false }),
        },
        token: "AABB0011CCDDEEF2",
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("2 Tickets");
    expect(html).not.toContain("Your Purchase");
  });

  test("renders multi-day booking range when daily listing has duration > 1", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee({ date: "2026-06-12" }),
          listing: testListingWithCount({
            duration_days: 3,
            listing_type: "daily",
          }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    // duration=3 starting 2026-06-12 → covers 12, 13, 14 inclusive.
    expect(html).toContain("12–14 June 2026");
  });
});

describeWithEnv(
  "listing images",
  { env: { STORAGE_ZONE_KEY: "testkey", STORAGE_ZONE_NAME: "testzone" } },
  () => {
    describe("renderListingImage", () => {
      test("returns empty string when image_url is null", () => {
        const html = renderListingImage({ image_url: "" });
        expect(html).toBe("");
      });

      test("renders img tag with proxy URL when image_url is set", () => {
        const html = renderListingImage({
          image_url: "abc123.jpg",
        });
        expect(html).toContain("/image/abc123.jpg");
        expect(html).toContain('alt=""');
        expect(html).toContain('class="listing-image"');
      });

      test("uses empty alt text for decorative image", () => {
        const html = renderListingImage({
          image_url: "img.jpg",
        });
        expect(html).toContain('alt=""');
      });
    });

    describe("ticketPage with image", () => {
      const renderSingleListing = (ev: ListingWithCount) =>
        ticketPage({
          dates: [],
          listings: [buildTicketListing(ev, false, undefined)],
          slugs: [ev.slug],
          terms: null,
        });

      test("shows listing image when image_url is set", () => {
        const listing = testListingWithCount({ image_url: "listing-img.jpg" });
        const html = renderSingleListing(listing);
        expect(html).toContain("/image/listing-img.jpg");
        expect(html).toContain('class="listing-image"');
      });

      test("does not show image when image_url is null", () => {
        const listing = testListingWithCount({ image_url: "" });
        const html = renderSingleListing(listing);
        expect(html).not.toContain("/image/");
      });

      test("does not show image in iframe mode", () => {
        detectIframeMode("https://example.com/?iframe=true");
        const listing = testListingWithCount({ image_url: "listing-img.jpg" });
        const html = renderSingleListing(listing);
        expect(html).not.toContain("listing-img.jpg");
        detectIframeMode("https://example.com/");
      });
    });

    describe("ticketPage with images", () => {
      test("shows image before each listing with image_url", () => {
        const listings = [
          buildTicketListing(
            testListingWithCount({
              id: 1,
              image_url: "img-a.jpg",
              name: "Listing A",
            }),
            false,
            undefined,
          ),
          buildTicketListing(
            testListingWithCount({
              id: 2,
              image_url: "img-b.jpg",
              name: "Listing B",
            }),
            false,
            undefined,
          ),
        ];
        const html = ticketPage({ listings, slugs: ["slug-a", "slug-b"] });
        expect(html).toContain("/image/img-a.jpg");
        expect(html).toContain("/image/img-b.jpg");
      });

      test("does not show images when image_url is null", () => {
        const listings = [
          buildTicketListing(
            testListingWithCount({ id: 1, image_url: "", name: "Listing A" }),
            false,
            undefined,
          ),
        ];
        const html = ticketPage({ listings, slugs: ["slug-a"] });
        expect(html).not.toContain("/image/");
      });
    });

    describe("ticketViewPage ticket count", () => {
      const token = "AABB0011CCDDEEFF";

      test("shows '1 Ticket' for single ticket", () => {
        const cards = [
          {
            entry: {
              attendee: testAttendee({ id: 1 }),
              listing: testListingWithCount({ id: 1 }),
            },
            token,
          },
        ];
        const html = ticketViewPage(cards);
        expect(html).toContain("1 Ticket");
      });

      test("shows '2 Tickets' for multiple tickets", () => {
        const cards = [
          {
            entry: {
              attendee: testAttendee({ id: 1 }),
              listing: testListingWithCount({ id: 1 }),
            },
            token: "AABB0011CCDDEEF1",
          },
          {
            entry: {
              attendee: testAttendee({ id: 2 }),
              listing: testListingWithCount({ id: 2 }),
            },
            token: "AABB0011CCDDEEF2",
          },
        ];
        const html = ticketViewPage(cards);
        expect(html).toContain("2 Tickets");
      });
    });

    describe("ticketViewPage with image", () => {
      const token = "AABB0011CCDDEEFF";

      test("shows image when listing has image_url", () => {
        const cards = [
          {
            entry: {
              attendee: testAttendee(),
              listing: testListingWithCount({ image_url: "ticket-img.jpg" }),
            },
            token,
          },
        ];
        const html = ticketViewPage(cards);
        expect(html).toContain("/image/ticket-img.jpg");
        expect(html).toContain('class="ticket-card-image"');
      });

      test("does not show image when image_url is empty", () => {
        const cards = [
          {
            entry: {
              attendee: testAttendee(),
              listing: testListingWithCount({ image_url: "" }),
            },
            token,
          },
        ];
        const html = ticketViewPage(cards);
        expect(html).not.toContain("ticket-card-image");
      });
    });
  },
);

describe("ticketPage day-count selector", () => {
  test("renders a priced day-count selector for a single customisable listing", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      customisable_days: true,
      day_prices: { 1: 1000, 2: 1800 },
      duration_days: 2,
      name: "Festival Pass",
      slug: "ab12c",
    });
    const html = ticketPage({
      listings: [buildTicketListing(listing, false, undefined)],
      slugs: ["ab12c"],
    });
    expect(html).toContain('name="day_count"');
    expect(html).toContain('<option value="1">1 day');
    expect(html).toContain('<option value="2">2 days');
    // The single-listing page annotates each option with its price.
    expect(html).toContain("2 days —");
  });

  test("shows an unavailable message when grouped listings share no day count", () => {
    // Two customisable listings offering disjoint counts intersect to nothing,
    // so the shared selector reports that no length is available.
    const a = buildTicketListing(
      testListingWithCount({
        attendee_count: 0,
        customisable_days: true,
        day_prices: { 1: 1000 },
        duration_days: 1,
        id: 1,
        name: "One Day Only",
        slug: "ab12c",
      }),
      false,
      undefined,
    );
    const b = buildTicketListing(
      testListingWithCount({
        attendee_count: 0,
        customisable_days: true,
        day_prices: { 2: 1800 },
        duration_days: 2,
        id: 2,
        name: "Two Days Only",
        slug: "cd34e",
      }),
      false,
      undefined,
    );
    const html = ticketPage({ listings: [a, b], slugs: ["ab12c", "cd34e"] });
    expect(html).toContain("No booking lengths are currently available.");
    expect(html).not.toContain('<option value="1">1 day');
  });

  test("renders shared day counts without per-option prices across a group", () => {
    // Two customisable listings that both offer a 1-day option share it; with
    // multiple listings there's no single price to show per option.
    const a = buildTicketListing(
      testListingWithCount({
        attendee_count: 0,
        customisable_days: true,
        day_prices: { 1: 1000, 2: 1800 },
        duration_days: 2,
        id: 1,
        name: "Listing A",
        slug: "ab12c",
      }),
      false,
      undefined,
    );
    const b = buildTicketListing(
      testListingWithCount({
        attendee_count: 0,
        customisable_days: true,
        day_prices: { 1: 1500, 2: 2400 },
        duration_days: 2,
        id: 2,
        name: "Listing B",
        slug: "cd34e",
      }),
      false,
      undefined,
    );
    const html = ticketPage({ listings: [a, b], slugs: ["ab12c", "cd34e"] });
    expect(html).toContain('name="day_count"');
    expect(html).toContain('<option value="1">1 day</option>');
    expect(html).toContain('<option value="2">2 days</option>');
  });

  test("omits the day-count selector for non-customisable listings", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      name: "Plain",
      slug: "ab12c",
    });
    const html = ticketPage({
      listings: [buildTicketListing(listing, false, undefined)],
      slugs: ["ab12c"],
    });
    expect(html).not.toContain('name="day_count"');
  });
});
