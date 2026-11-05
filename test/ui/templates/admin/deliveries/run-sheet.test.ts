import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type DeliveryBookingView,
  type DeliveryDayGroup,
  type DeliveryLegView,
  renderRunSheetDays,
} from "#templates/admin/deliveries/run-sheet.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";
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

    expectIncludesAll(html, [
      "Drop-off",
      "09:00",
      "Van 1",
      // Details are prefixed with bold labels.
      "<strong>Name:</strong> Alice",
      "<strong>Listing:</strong> Bouncy Castle",
      "<strong>Address:</strong> 1 Test Street",
      "https://www.google.com/maps/search/?api=1",
      "https://maps.apple.com/?q=",
      "<strong>Phone:</strong>",
      "tel:+447700900000",
      "https://wa.me/447700900000",
      // The toggle is the site's own CSRF-protected form.
      'action="/admin/deliveries/mark"',
      'name="csrf_token"',
      'value="start"',
      'name="date" type="hidden" value="2026-06-16"',
      "Mark done",
      // The ticket token the customer can quote is shown.
      "<strong>Token:</strong> TOKEN123",
    ]);
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

    expectIncludesAll(html, ["Drop-off", "Collection"]);
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

    expectIncludesAll(html, [
      "Collection",
      "Mark not done",
      "delivery-leg done",
      // Non-callable phone is shown as plain text, with no tel: link.
      "no-digits-here",
    ]);
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
    expectIncludesAll(html, [
      "&lt;script&gt;alert(1)&lt;/script&gt;",
      "Alice &amp; Bob",
      "1 &lt;b&gt;Bold&lt;/b&gt; Street",
      "&quot;; onload=&quot;",
    ]);
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
