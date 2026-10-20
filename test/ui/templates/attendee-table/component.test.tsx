import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { configurableTableLayouts } from "#shared/tables/configurable.ts";
import {
  attendeeTableSuite,
  makeOpts,
  makeRow,
  render,
  zaraAliceRows,
} from "#test/ui/templates/attendee-table/shared.ts";
import { testAttendee, testRadioQuestion } from "#test-utils/factories.ts";

attendeeTableSuite(() => {
  describe("component", () => {
    test("orchestrates a supplied layout, filters, and column context", () => {
      const columnLayout = configurableTableLayouts.attendee.parse(
        '{{registered | date: "%Y"}}, {{phone}}, {{ticket}}',
      );
      const attendee = testAttendee({
        created: "2026-04-05T12:00:00Z",
        phone: "0234 567 8900",
        ticket_token: "custom-token",
      });
      const html = render(
        makeOpts({
          allowedDomain: "tickets.example.test",
          columnLayout,
          phonePrefix: "1",
          rows: [makeRow({ attendee })],
        }),
      );

      assertStringIncludes(
        html,
        "<thead><tr><th>Registered</th><th>Phone</th><th>Ticket</th></tr></thead>",
      );
      assertStringIncludes(html, "<td>2026</td>");
      assertStringIncludes(html, 'href="tel:+12345678900"');
      assertStringIncludes(
        html,
        '<a href="https://tickets.example.test/t/custom-token">custom-token</a>',
      );
      assert(!html.includes("Check in"));
    });

    test("uses the saved default layout and default phone prefix", () => {
      const attendee = testAttendee({ phone: "07700 900000" });
      const html = render(makeOpts({ rows: [makeRow({ attendee })] }));

      assertStringIncludes(html, 'class="link-button checkin"');
      assertStringIncludes(html, "<th>Name</th>");
      assertStringIncludes(html, "<th>Phone</th>");
      assertStringIncludes(html, 'href="tel:+447700900000"');
    });

    test("sorts rows unless the caller marks them as presorted", () => {
      const sorted = render(
        makeOpts({ rows: zaraAliceRows(), showListing: true }),
      );
      const presorted = render(
        makeOpts({
          presorted: true,
          rows: zaraAliceRows(),
          showListing: true,
        }),
      );

      expect(sorted.indexOf("Alice")).toBeLessThan(sorted.indexOf("Zara"));
      expect(presorted.indexOf("Zara")).toBeLessThan(
        presorted.indexOf("Alice"),
      );
    });

    test("drops empty question data but maps populated answers into context", () => {
      const empty = render(
        makeOpts({
          questionData: { attendeeAnswerMap: new Map(), questions: [] },
        }),
      );
      const populated = render(
        makeOpts({
          questionData: {
            attendeeAnswerMap: new Map([[1, [10]]]),
            questions: [testRadioQuestion(2, "Meal?", [[10, "Vegan"]])],
          },
        }),
      );

      assert(!empty.includes("<th>Answers</th>"));
      assertStringIncludes(populated, "<th>Answers</th>");
      assertStringIncludes(
        populated,
        '<span title="Meal?: Vegan">Vegan</span>',
      );
    });

    test("marks only servicing rows with servicing attributes", () => {
      const html = render(
        makeOpts({
          columnLayout: configurableTableLayouts.attendee.parse("{{name}}"),
          presorted: true,
          rows: [
            makeRow({ attendee: testAttendee({ id: 1, name: "Regular" }) }),
            makeRow({
              attendee: testAttendee({
                id: 2,
                kind: "servicing",
                name: "Delivery",
              }),
            }),
          ],
        }),
      );

      assertStringIncludes(html, "<tbody><tr><td>");
      assertStringIncludes(
        html,
        '<tr class="servicing-event" data-servicing="true"><td>',
      );
      expect(html.match(/data-servicing="true"/g)).toHaveLength(1);
    });

    test("uses custom and translated empty messages", () => {
      const layout = configurableTableLayouts.attendee.parse("{{name}}");
      const translated = render(makeOpts({ columnLayout: layout, rows: [] }));
      const custom = render(
        makeOpts({
          columnLayout: layout,
          emptyMessage: "Pick a day",
          rows: [],
        }),
      );

      assertStringIncludes(translated, '<td colspan="1">No attendees yet</td>');
      assertStringIncludes(custom, '<td colspan="1">Pick a day</td>');
      assert(!custom.includes("No attendees yet"));
    });
  });
});
