import { expect } from "@std/expect";
import { afterEach, beforeAll, describe, it as test } from "@std/testing/bdd";
import { getCurrentCsrfToken, signCsrfToken } from "#shared/csrf.ts";
import { addDays } from "#shared/dates.ts";
import { settings } from "#shared/db/settings.ts";
import { detectIframeMode } from "#shared/iframe.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { EventWithCount } from "#shared/types.ts";
import {
  buildOgTags,
  buildTicketEvent,
  notFoundPage,
  renderEventImage,
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
  testEventWithCount,
} from "#test-utils";

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

afterEach(() => {
  detectIframeMode("https://example.com/");
});

describe("ticketPage (single event)", () => {
  const event = testEventWithCount({ attendee_count: 50 });
  const renderTicket = (
    ev: EventWithCount,
    opts?: {
      error?: string;
      isClosed?: boolean;
      iframe?: boolean;
      dates?: string[];
      terms?: string | null;
      baseUrl?: string;
      questions?: {
        id: number;
        text: string;
        answers: {
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
      baseUrl: opts?.baseUrl,
      dates: opts?.dates ?? [],
      error: opts?.error,
      events: [buildTicketEvent(ev, opts?.isClosed ?? false, undefined)],
      questions: opts?.questions,
      slugs: [ev.slug],
      terms: opts?.terms,
    });
  };

  test("renders page title", () => {
    const html = renderTicket(event);
    expect(html).toContain("Test Event");
  });

  test("renders registration form when spots available", () => {
    const html = renderTicket(event);
    expect(html).toContain('action="/ticket/ab12c"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="email"');
    expect(html).toContain("Continue");
  });

  test("includes CSRF token in form", () => {
    const html = renderTicket(event);
    expect(html).toContain('name="csrf_token"');
    expect(html).toContain(`value="${getCurrentCsrfToken()}"`);
  });

  test("shows error when provided", () => {
    const html = renderTicket(event, {
      error: "Name and email are required",
    });
    expect(html).toContain("Name and email are required");
    expect(html).toContain('class="error"');
  });

  test("shows full message when no spots", () => {
    const fullEvent = testEventWithCount({ attendee_count: 100 });
    const html = renderTicket(fullEvent);
    expect(html).toContain("this event is full");
    expect(html).not.toContain(">Reserve Ticket</button>");
  });

  test("displays event name as header", () => {
    const html = renderTicket(event);
    expect(html).toContain("<h1>Test Event</h1>");
  });

  test("shows quantity selector when max_quantity > 1 and spots available", () => {
    const multiQtyEvent = testEventWithCount({
      attendee_count: 0,
      max_quantity: 5,
    });
    const html = renderTicket(multiQtyEvent);
    expect(html).toContain("Number of Tickets");
    expect(html).toContain(`name="quantity_${multiQtyEvent.id}"`);
    expect(html).toContain('<option value="1">1</option>');
    expect(html).toContain('<option value="5">5</option>');
    expect(html).toContain("Continue");
  });

  test("limits quantity selector to remaining spots", () => {
    const limitedEvent = testEventWithCount({
      attendee_count: 97, // Only 3 spots remaining
      max_quantity: 10,
    });
    const html = renderTicket(limitedEvent);
    expect(html).toContain("Number of Tickets");
    expect(html).toContain('<option value="3">3</option>');
    expect(html).not.toContain('<option value="4">4</option>');
  });

  test("hides quantity selector when max_quantity is 1", () => {
    const html = renderTicket(event); // max_quantity is 1
    expect(html).not.toContain("Number of Tickets");
    expect(hasInputWithValue(html, `quantity_${event.id}`, "1")).toBe(true);
    expect(html).toContain("Continue");
  });

  test("shows Continue button for purchase_only event", () => {
    const poEvent = testEventWithCount({
      attendee_count: 50,
      purchase_only: true,
    });
    const html = renderTicket(poEvent);
    expect(html).toContain("Continue");
  });

  test("shows phone field for phone-only events", () => {
    const phoneEvent = testEventWithCount({
      attendee_count: 50,
      fields: "phone",
    });
    const html = renderTicket(phoneEvent);
    expect(html).toContain('name="phone"');
    expect(html).toContain("Your Phone Number");
    expect(html).not.toContain('name="email"');
  });

  test("shows both email and phone for email,phone setting", () => {
    const bothEvent = testEventWithCount({
      attendee_count: 50,
      fields: "email,phone",
    });
    const html = renderTicket(bothEvent);
    expect(html).toContain('name="email"');
    expect(html).toContain('name="phone"');
  });

  test("shows only email for email setting", () => {
    const html = renderTicket(event);
    expect(html).toContain('name="email"');
    expect(html).not.toContain('name="phone"');
  });

  test("hides header and description in iframe mode", () => {
    const eventWithDesc = testEventWithCount({
      attendee_count: 50,
      description: "A great event",
    });
    const html = renderTicket(eventWithDesc, { iframe: true });
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("A great event");
    expect(html).toContain('class="iframe"');
    expect(html).toContain('name="name"');
  });

  test("shows header and description when not in iframe mode", () => {
    const eventWithDesc = testEventWithCount({
      attendee_count: 50,
      description: "A great event",
    });
    const html = renderTicket(eventWithDesc);
    expect(html).toContain("<h1>Test Event</h1>");
    expect(html).toContain("A great event");
    expect(html).not.toContain('class="iframe"');
  });

  test("includes iframe-resizer child script in iframe mode", () => {
    const html = renderTicket(event, { iframe: true });
    expect(html).toContain("iframe-resizer-child.js");
  });

  test("excludes iframe-resizer child script when not in iframe mode", () => {
    const html = renderTicket(event);
    expect(html).not.toContain("iframe-resizer-child.js");
  });

  test("renders terms and conditions with checkbox", () => {
    const html = renderTicket(event, { terms: "No refunds allowed" });
    expect(html).toContain("No refunds allowed");
    expect(html).toContain('class="prose"');
    expect(html).toContain('name="agree_terms"');
  });

  test("renders markdown paragraphs in terms and conditions", () => {
    const html = renderTicket(event, {
      terms: "Line one\n\nLine two\n\nLine three",
    });
    expect(html).toContain("<p>Line one</p>");
    expect(html).toContain("<p>Line two</p>");
    expect(html).toContain("<p>Line three</p>");
  });

  test("does not render terms when not provided", () => {
    const html = renderTicket(event);
    expect(html).not.toContain('class="terms"');
    expect(html).not.toContain('name="agree_terms"');
  });

  test("renders custom questions when provided", () => {
    const questions = [
      {
        answers: [
          { id: 10, question_id: 1, sort_order: 0, text: "Small" },
          { id: 11, question_id: 1, sort_order: 1, text: "Large" },
        ],
        id: 1,
        text: "Size?",
      },
    ];
    const html = renderTicket(event, { questions });
    expect(html).toContain("Size?");
    expect(html).toContain('name="question_1"');
  });

  test("includes OpenGraph tags when baseUrl is provided", () => {
    const ev = testEventWithCount({
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
    const html = renderTicket(event);
    expect(html).not.toContain("og:title");
  });
});

describe("buildOgTags", () => {
  test("includes title, type, and url", () => {
    const html = buildOgTags(
      { description: "", image_url: "", name: "My Event", slug: "my-event" },
      "https://example.com",
    );
    expect(html).toContain('<meta property="og:title" content="My Event">');
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain(
      '<meta property="og:url" content="https://example.com/ticket/my-event">',
    );
  });

  test("includes description when present", () => {
    const html = buildOgTags(
      {
        description: "Come join us",
        image_url: "",
        name: "My Event",
        slug: "my-event",
      },
      "https://example.com",
    );
    expect(html).toContain(
      '<meta property="og:description" content="Come join us">',
    );
  });

  test("excludes description when empty", () => {
    const html = buildOgTags(
      { description: "", image_url: "", name: "My Event", slug: "my-event" },
      "https://example.com",
    );
    expect(html).not.toContain("og:description");
  });

  test("includes image when present", () => {
    const html = buildOgTags(
      {
        description: "",
        image_url: "photo.jpg",
        name: "My Event",
        slug: "my-event",
      },
      "https://example.com",
    );
    expect(html).toContain(
      '<meta property="og:image" content="https://example.com/image/photo.jpg">',
    );
  });

  test("excludes image when empty", () => {
    const html = buildOgTags(
      { description: "", image_url: "", name: "My Event", slug: "my-event" },
      "https://example.com",
    );
    expect(html).not.toContain("og:image");
  });

  test("escapes HTML in event name", () => {
    const html = buildOgTags(
      {
        description: "",
        image_url: "",
        name: 'Event "with quotes"',
        slug: "my-event",
      },
      "https://example.com",
    );
    expect(html).toContain("Event &quot;with quotes&quot;");
    expect(html).not.toContain('content="Event "with quotes""');
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

describe("siteNotActivatedPage", () => {
  test("renders not-activated message in the error dialog style", () => {
    const html = siteNotActivatedPage();
    expect(html).toContain("<h1>Not Activated</h1>");
    expect(html).toContain("This site has not been activated yet.");
    expect(html).toContain("<style>");
    expect(html).toContain("font-family:system-ui");
  });

  test("does not auto-refresh", () => {
    const html = siteNotActivatedPage();
    expect(html).not.toContain('http-equiv="refresh"');
  });
});

describe("ticketPage", () => {
  test("shows all sold out message when every event is sold out", () => {
    const events = [
      buildTicketEvent(
        testEventWithCount({
          attendee_count: 100,
          id: 1,
          max_attendees: 100,
          name: "Event A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
      buildTicketEvent(
        testEventWithCount({
          attendee_count: 50,
          id: 2,
          max_attendees: 50,
          name: "Event B",
          slug: "cd34e",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ events, slugs: ["ab12c", "cd34e"] });
    expect(html).toContain("Sorry, all events are sold out.");
    expect(html).not.toContain("Reserve Tickets</button>");
  });

  test("renders markdown paragraphs in terms and conditions", () => {
    const events = [
      buildTicketEvent(
        testEventWithCount({
          attendee_count: 0,
          id: 1,
          name: "Event A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({
      events,
      slugs: ["ab12c"],
      terms: "Rule one\n\nRule two",
    });
    expect(html).toContain("<p>Rule one</p>");
    expect(html).toContain("<p>Rule two</p>");
    expect(html).toContain('name="agree_terms"');
  });

  test("renders custom questions with event IDs", () => {
    const events = [
      buildTicketEvent(
        testEventWithCount({
          attendee_count: 0,
          id: 1,
          name: "Event A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const questions = [
      {
        answers: [{ id: 10, question_id: 5, sort_order: 0, text: "Small" }],
        id: 5,
        text: "Size?",
      },
    ];
    const questionEventMap = new Map([[5, [1]]]);
    const html = ticketPage({
      events,
      questionEventMap,
      questions,
      slugs: ["ab12c"],
    });
    expect(html).toContain("Size?");
    expect(html).toContain('name="question_5"');
    expect(html).toContain('data-event-ids="1"');
  });

  test("appends ?iframe=true to form action in iframe mode", () => {
    detectIframeMode("https://example.com/?iframe=true");
    const events = [
      buildTicketEvent(
        testEventWithCount({
          attendee_count: 0,
          id: 1,
          name: "Event A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ events, slugs: ["ab12c"] });
    expect(html).toContain('action="/ticket/ab12c?iframe=true"');
    expect(html).toContain('class="iframe"');
    detectIframeMode("https://example.com/");
  });

  test("includes iframe-resizer child script in iframe mode", () => {
    detectIframeMode("https://example.com/?iframe=true");
    const events = [
      buildTicketEvent(
        testEventWithCount({
          attendee_count: 0,
          id: 1,
          name: "Event A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ events, slugs: ["ab12c"] });
    expect(html).toContain("iframe-resizer-child.js");
    detectIframeMode("https://example.com/");
  });

  test("excludes iframe-resizer child script without iframe mode", () => {
    const events = [
      buildTicketEvent(
        testEventWithCount({
          attendee_count: 0,
          id: 1,
          name: "Event A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ events, slugs: ["ab12c"] });
    expect(html).not.toContain("iframe-resizer-child.js");
  });

  test("does not append ?iframe=true without iframe mode", () => {
    const events = [
      buildTicketEvent(
        testEventWithCount({
          attendee_count: 0,
          id: 1,
          name: "Event A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ events, slugs: ["ab12c"] });
    expect(html).toContain('action="/ticket/ab12c"');
    expect(html).not.toContain("?iframe=true");
    expect(html).not.toContain('class="iframe"');
  });

  test("hides quantity selector for single event with max quantity 1", () => {
    const events = [
      buildTicketEvent(
        testEventWithCount({
          attendee_count: 0,
          id: 1,
          max_quantity: 1,
          name: "Event A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ events, slugs: ["ab12c"] });
    expect(hasInputWithValue(html, "quantity_1", "1")).toBe(true);
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Select Tickets");
  });

  test("shows quantity selector for single event with max quantity above 1", () => {
    const events = [
      buildTicketEvent(
        testEventWithCount({
          attendee_count: 0,
          id: 1,
          max_quantity: 3,
          name: "Event A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ events, slugs: ["ab12c"] });
    expect(html).toContain("<select");
    expect(html).toContain('name="quantity_1"');
    expect(html).toContain("Number of Tickets");
    expect(hasInputWithValue(html, "quantity_1", "1")).toBe(false);
  });

  test("shows quantity selector for multiple events even with max quantity 1", () => {
    const events = [
      buildTicketEvent(
        testEventWithCount({
          attendee_count: 0,
          id: 1,
          max_quantity: 1,
          name: "Event A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
      buildTicketEvent(
        testEventWithCount({
          attendee_count: 0,
          id: 2,
          max_quantity: 1,
          name: "Event B",
          slug: "cd34e",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ events, slugs: ["ab12c", "cd34e"] });
    expect(html).toContain("<select");
    expect(html).toContain("Select Tickets");
  });

  test("hides quantity selector when one event available and one sold out", () => {
    const events = [
      buildTicketEvent(
        testEventWithCount({
          attendee_count: 0,
          id: 1,
          max_quantity: 1,
          name: "Event A",
          slug: "ab12c",
        }),
        false,
        undefined,
      ),
      buildTicketEvent(
        testEventWithCount({
          attendee_count: 50,
          id: 2,
          max_attendees: 50,
          name: "Event B",
          slug: "cd34e",
        }),
        false,
        undefined,
      ),
    ];
    const html = ticketPage({ events, slugs: ["ab12c", "cd34e"] });
    expect(hasInputWithValue(html, "quantity_1", "1")).toBe(true);
    expect(html).not.toContain("Select Tickets");
  });
});

describe("ticketPage event date and location", () => {
  const renderTicket = (ev: EventWithCount, opts?: { iframe?: boolean }) => {
    if (opts?.iframe) detectIframeMode("https://example.com/?iframe=true");
    else detectIframeMode("https://example.com/");
    return ticketPage({
      dates: [],
      events: [buildTicketEvent(ev, false, undefined)],
      slugs: [ev.slug],
    });
  };

  test("shows date on public ticket page when event has date", () => {
    const event = testEventWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
    });
    const html = renderTicket(event);
    expect(html).toContain("<strong>Date:</strong>");
    expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
  });

  test("does not show date on public ticket page when date is empty", () => {
    const event = testEventWithCount({ attendee_count: 0, date: "" });
    const html = renderTicket(event);
    expect(html).not.toContain("<strong>Date:</strong>");
  });

  test("shows location on public ticket page when event has location", () => {
    const event = testEventWithCount({
      attendee_count: 0,
      location: "Village Hall",
    });
    const html = renderTicket(event);
    expect(html).toContain("<strong>Location:</strong>");
    expect(html).toContain("Village Hall");
  });

  test("does not show location on public ticket page when location is empty", () => {
    const event = testEventWithCount({ attendee_count: 0, location: "" });
    const html = renderTicket(event);
    expect(html).not.toContain("<strong>Location:</strong>");
  });

  test("hides date and location in iframe mode", () => {
    const event = testEventWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
      location: "Village Hall",
    });
    const html = renderTicket(event, { iframe: true });
    expect(html).not.toContain("<strong>Date:</strong>");
    expect(html).not.toContain("<strong>Location:</strong>");
  });

  test("shows past event badge for event with date in the past", () => {
    const event = testEventWithCount({
      attendee_count: 0,
      date: "2020-01-15T14:00:00.000Z",
    });
    const html = renderTicket(event);
    expect(html).toContain("badge-alert");
    expect(html).toContain("ago");
  });

  test("does not show past event badge for future event", () => {
    const event = testEventWithCount({
      attendee_count: 0,
      date: "2099-06-15T14:00:00.000Z",
    });
    const html = renderTicket(event);
    expect(html).not.toContain("badge-alert");
  });

  test("does not show past event badge when date is empty", () => {
    const event = testEventWithCount({ attendee_count: 0, date: "" });
    const html = renderTicket(event);
    expect(html).not.toContain("badge-alert");
  });

  test("past event badge shows singular day for 1 day ago", () => {
    const yesterday = addDays(todayInTz(settings.timezone), -1);
    const event = testEventWithCount({
      attendee_count: 0,
      date: `${yesterday}T12:00:00.000Z`,
    });
    const html = renderTicket(event);
    expect(html).toContain("1 day ago");
    expect(html).not.toContain("(1 day ago)");
  });

  test("past event badge shows plural days for multiple days ago", () => {
    const threeDaysAgo = addDays(todayInTz(settings.timezone), -3);
    const event = testEventWithCount({
      attendee_count: 0,
      date: `${threeDaysAgo}T12:00:00.000Z`,
    });
    const html = renderTicket(event);
    expect(html).toContain("3 days ago");
    expect(html).not.toContain("(3 days ago)");
  });
});

describe("ticketViewPage event date and location", () => {
  const token = "AABB0011CCDDEEFF";

  test("shows event date when entry has non-empty event date", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          event: testEventWithCount({ date: "2026-06-15T14:00:00.000Z" }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("Monday 15 June 2026 at 15:00 GMT+1");
  });

  test("does not show event date when event has empty date", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          event: testEventWithCount({ date: "" }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).not.toContain("ticket-card-date");
  });

  test("shows location when entry has non-empty location", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          event: testEventWithCount({ location: "Village Hall" }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("Village Hall");
  });

  test("does not show location when event has empty location", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          event: testEventWithCount({ location: "" }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).not.toContain("ticket-card-location");
  });

  test("shows both event date and location when both are present", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          event: testEventWithCount({
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
          event: testEventWithCount({
            date: "2026-06-15T14:00:00.000Z",
            id: 1,
          }),
        },
        token: "AABB0011CCDDEEF1",
      },
      {
        entry: {
          attendee: testAttendee({ id: 2 }),
          event: testEventWithCount({ date: "", id: 2 }),
        },
        token: "AABB0011CCDDEEF2",
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("/t/AABB0011CCDDEEF1/svg");
    expect(html).toContain("/t/AABB0011CCDDEEF2/svg");
    expect(html).toContain("2 Tickets");
  });

  test("hides QR code and token for purchase_only events", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          event: testEventWithCount({ purchase_only: true }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).not.toContain("ticket-card-qr");
    expect(html).not.toContain("ticket-card-token");
    expect(html).not.toContain("/svg");
  });

  test("hides wallet links for purchase_only events", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          event: testEventWithCount({ purchase_only: true }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards, true, true);
    expect(html).not.toContain("wallet-link");
    expect(html).not.toContain("Apple Wallet");
    expect(html).not.toContain("Google Wallet");
  });

  test("hides non-transferable notice for purchase_only events", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          event: testEventWithCount({
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

  test("shows Your Purchase heading for purchase_only events", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee(),
          event: testEventWithCount({ purchase_only: true }),
        },
        token,
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("Your Purchase");
    expect(html).not.toContain("Ticket");
  });

  test("shows ticket count heading for mixed events", () => {
    const cards = [
      {
        entry: {
          attendee: testAttendee({ id: 1 }),
          event: testEventWithCount({ id: 1, purchase_only: true }),
        },
        token: "AABB0011CCDDEEF1",
      },
      {
        entry: {
          attendee: testAttendee({ id: 2 }),
          event: testEventWithCount({ id: 2, purchase_only: false }),
        },
        token: "AABB0011CCDDEEF2",
      },
    ];
    const html = ticketViewPage(cards);
    expect(html).toContain("2 Tickets");
    expect(html).not.toContain("Your Purchase");
  });
});

describeWithEnv(
  "event images",
  { env: { STORAGE_ZONE_KEY: "testkey", STORAGE_ZONE_NAME: "testzone" } },
  () => {
    describe("renderEventImage", () => {
      test("returns empty string when image_url is null", () => {
        const html = renderEventImage({ image_url: "" });
        expect(html).toBe("");
      });

      test("renders img tag with proxy URL when image_url is set", () => {
        const html = renderEventImage({
          image_url: "abc123.jpg",
        });
        expect(html).toContain("/image/abc123.jpg");
        expect(html).toContain('alt=""');
        expect(html).toContain('class="event-image"');
      });

      test("uses empty alt text for decorative image", () => {
        const html = renderEventImage({
          image_url: "img.jpg",
        });
        expect(html).toContain('alt=""');
      });
    });

    describe("ticketPage with image", () => {
      const renderSingleEvent = (ev: EventWithCount) =>
        ticketPage({
          dates: [],
          events: [buildTicketEvent(ev, false, undefined)],
          slugs: [ev.slug],
          terms: null,
        });

      test("shows event image when image_url is set", () => {
        const event = testEventWithCount({ image_url: "event-img.jpg" });
        const html = renderSingleEvent(event);
        expect(html).toContain("/image/event-img.jpg");
        expect(html).toContain('class="event-image"');
      });

      test("does not show image when image_url is null", () => {
        const event = testEventWithCount({ image_url: "" });
        const html = renderSingleEvent(event);
        expect(html).not.toContain("/image/");
      });

      test("does not show image in iframe mode", () => {
        detectIframeMode("https://example.com/?iframe=true");
        const event = testEventWithCount({ image_url: "event-img.jpg" });
        const html = renderSingleEvent(event);
        expect(html).not.toContain("event-img.jpg");
        detectIframeMode("https://example.com/");
      });
    });

    describe("ticketPage with images", () => {
      test("shows image before each event with image_url", () => {
        const events = [
          buildTicketEvent(
            testEventWithCount({
              id: 1,
              image_url: "img-a.jpg",
              name: "Event A",
            }),
            false,
            undefined,
          ),
          buildTicketEvent(
            testEventWithCount({
              id: 2,
              image_url: "img-b.jpg",
              name: "Event B",
            }),
            false,
            undefined,
          ),
        ];
        const html = ticketPage({ events, slugs: ["slug-a", "slug-b"] });
        expect(html).toContain("/image/img-a.jpg");
        expect(html).toContain("/image/img-b.jpg");
      });

      test("does not show images when image_url is null", () => {
        const events = [
          buildTicketEvent(
            testEventWithCount({ id: 1, image_url: "", name: "Event A" }),
            false,
            undefined,
          ),
        ];
        const html = ticketPage({ events, slugs: ["slug-a"] });
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
              event: testEventWithCount({ id: 1 }),
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
              event: testEventWithCount({ id: 1 }),
            },
            token: "AABB0011CCDDEEF1",
          },
          {
            entry: {
              attendee: testAttendee({ id: 2 }),
              event: testEventWithCount({ id: 2 }),
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

      test("shows image when event has image_url", () => {
        const cards = [
          {
            entry: {
              attendee: testAttendee(),
              event: testEventWithCount({ image_url: "ticket-img.jpg" }),
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
              event: testEventWithCount({ image_url: "" }),
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
