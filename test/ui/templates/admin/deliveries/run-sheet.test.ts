import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type DeliveryBookingView,
  type DeliveryDayGroup,
  type DeliveryLegView,
  renderRunSheetDays,
} from "#templates/admin/deliveries/run-sheet.tsx";
import { testDate } from "#test-utils/dates.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

const TODAY = testDate("2026-06-16");

const leg = (over: Partial<DeliveryLegView> = {}): DeliveryLegView => ({
  agentName: "Van 1",
  date: "2026-06-16",
  done: false,
  kind: "start",
  time: "09:00",
  ...over,
});

const booking = (
  over: Partial<DeliveryBookingView> = {},
): DeliveryBookingView => ({
  address: "1 Test Street",
  attendeeId: 5,
  attendeeName: "Alice",
  legs: [leg()],
  listingId: 9,
  listingName: "Bouncy Castle",
  phone: "07700900000",
  ticketToken: "TOKEN123",
  ...over,
});

const group = (over: Partial<DeliveryDayGroup> = {}): DeliveryDayGroup => ({
  bookings: [booking()],
  date: TODAY,
  ...over,
});

type Templates = { bodyTemplate?: string; headingTemplate?: string };

/** Render one day through the templates, the way the route does. */
const renderOne = async (
  day: DeliveryDayGroup,
  templates: Templates = {},
): Promise<{ bodyHtml: string; empty: boolean; heading: string }> => {
  const [rendered] = await withRequestContext(() =>
    renderRunSheetDays([day], {
      bodyTemplate: templates.bodyTemplate ?? "",
      headingTemplate: templates.headingTemplate ?? "",
      phonePrefix: "44",
      today: TODAY,
    }),
  );
  return rendered!;
};

const renderBody = async (
  day: DeliveryDayGroup,
  templates: Templates = {},
): Promise<string> => (await renderOne(day, templates)).bodyHtml;

describe("renderRunSheetDays", () => {
  test("reads a day against the real today as Today, Tomorrow, or a date", async () => {
    const days = await withRequestContext(() =>
      renderRunSheetDays(
        [
          group({ date: TODAY }),
          group({ date: testDate("2026-06-17") }),
          group({ date: testDate("2026-07-06") }),
        ],
        {
          bodyTemplate: "",
          headingTemplate: "",
          phonePrefix: "44",
          today: TODAY,
        },
      ),
    );

    expect(days.map((day) => day.heading)).toEqual([
      "Today",
      "Tomorrow",
      "Monday 6 July 2026",
    ]);
  });

  test("renders a drop-off booking with labelled details, maps, phone and a done toggle", async () => {
    const html = await renderBody(group());

    assertStringIncludes(html, "Drop-off");
    assertStringIncludes(html, "09:00");
    assertStringIncludes(html, "Van 1");
    // Details are prefixed with bold labels.
    assertStringIncludes(html, "<strong>Name:</strong> Alice");
    assertStringIncludes(html, "<strong>Listing:</strong> Bouncy Castle");
    assertStringIncludes(html, "<strong>Address:</strong> 1 Test Street");
    assertStringIncludes(html, "https://www.google.com/maps/search/?api=1");
    assertStringIncludes(html, "https://maps.apple.com/?q=");
    assertStringIncludes(html, "<strong>Phone:</strong>");
    assertStringIncludes(html, "tel:+447700900000");
    assertStringIncludes(html, "https://wa.me/447700900000");
    // The toggle is the site's own CSRF-protected form.
    assertStringIncludes(html, 'action="/admin/deliveries/mark"');
    assertStringIncludes(html, 'name="csrf_token"');
    assertStringIncludes(html, 'value="start"');
    assertStringIncludes(html, 'name="date" type="hidden" value="2026-06-16"');
    assertStringIncludes(html, "Mark done");
    // The ticket token the customer can quote is shown.
    assertStringIncludes(html, "<strong>Token:</strong> TOKEN123");
  });

  test("shows both the drop-off and collection jobs for a same-day booking", async () => {
    const html = await renderBody(
      group({
        bookings: [
          booking({
            legs: [
              leg({ kind: "end", time: "17:00" }),
              leg({ kind: "start", time: "09:00" }),
            ],
          }),
        ],
      }),
    );

    assertStringIncludes(html, "Drop-off");
    assertStringIncludes(html, "Collection");
    // The shared booking details appear once, not once per leg.
    expect(html.match(/Bouncy Castle/g)).toHaveLength(1);
  });

  test("renders a collection job, a done job, and tolerates missing fields", async () => {
    const html = await renderBody(
      group({
        bookings: [
          booking({
            address: "",
            legs: [leg({ done: true, kind: "end", time: "" })],
            phone: "no-digits-here",
          }),
        ],
      }),
    );

    assertStringIncludes(html, "Collection");
    assertStringIncludes(html, "Mark not done");
    assertStringIncludes(html, "delivery-leg done");
    // Non-callable phone is shown as plain text, with no tel: link.
    assertStringIncludes(html, "no-digits-here");
    assert(!html.includes("tel:"));
    // Blank address and map lines are left out.
    assert(!html.includes("1 Test Street"));
    assert(!html.includes("maps/search"));
  });

  test("omits the phone line entirely when there is no phone", async () => {
    const html = await renderBody(
      group({ bookings: [booking({ phone: "" })] }),
    );

    assert(!html.includes("delivery-phone"));
  });

  test("says so when a day has no bookings", async () => {
    const html = await renderBody(group({ bookings: [] }));

    assertStringIncludes(html, "Nothing scheduled");
  });

  test("escapes every value a person typed, and the listing name", async () => {
    const html = await renderBody(
      group({
        bookings: [
          booking({
            address: "1 <b>Bold</b> Street",
            attendeeName: "<script>alert(1)</script>",
            listingName: "Alice & Bob",
            phone: '"; onload="',
          }),
        ],
      }),
    );

    assert(!html.includes("<script>"));
    assertStringIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
    assertStringIncludes(html, "Alice &amp; Bob");
    assertStringIncludes(html, "1 &lt;b&gt;Bold&lt;/b&gt; Street");
    assertStringIncludes(html, "&quot;; onload=&quot;");
  });

  test("renders the owner's body template with the day's bookings", async () => {
    const html = await renderBody(group(), {
      bodyTemplate:
        "{% for item in day.bookings %}<h3>{{ item.name }} at {{ item.listing }}</h3>{% endfor %}",
    });

    expect(html).toBe("<h3>Alice at Bouncy Castle</h3>");
  });

  test("renders the owner's heading template with the day's facts", async () => {
    const { heading } = await renderOne(
      group({ date: testDate("2026-06-17") }),
      {
        headingTemplate: "{{ relative }} on {{ date }}",
      },
    );

    expect(heading).toBe("tomorrow on 2026-06-17");
  });

  test("leaves the mark toggle out when the owner's template drops it", async () => {
    const html = await renderBody(group(), {
      bodyTemplate: "{{ day.bookings.size }} booking(s)",
    });

    expect(html).toBe("1 booking(s)");
    assert(!html.includes('action="/admin/deliveries/mark"'));
  });

  test("uses the built-in wording when a template box is blank", async () => {
    const blank = await renderBody(group(), {
      bodyTemplate: "   ",
      headingTemplate: "\n",
    });
    const defaults = await renderBody(group());

    expect(blank).toBe(defaults);
    assertStringIncludes(blank, "Bouncy Castle");
  });
});
