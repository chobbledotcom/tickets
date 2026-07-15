import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildSharedDetailRows,
  calculateTotalRevenue,
  countCheckedIn,
  countCheckedInRows,
  type DetailRow,
  type SharedDetailInput,
  sumQuantity,
} from "#templates/admin/detail-rows.tsx";
import { DetailTable } from "#templates/components/detail-table.tsx";
import { LabelledRow } from "#templates/components/labelled-row.tsx";
import {
  singleAnswerSizeQuestionData,
  sizeQuestionAnswerData,
  testAnswer,
  testAttendee,
  testQuestion,
  unselectedAnswerQuestionData,
} from "#test-utils/factories.ts";

describe("detail-rows", () => {
  const answerSummaryRows = (
    questionData: SharedDetailInput["questionData"],
  ): DetailRow[] =>
    buildSharedDetailRows({
      attendeeCount: 0,
      attendees: [],
      hasPaidListing: false,
      maxCapacity: 0,
      questionData,
      skipAttendees: true,
    }).slice(1);

  describe("DetailTable", () => {
    test("renders no rows when none are passed", () => {
      expect(String(DetailTable({}))).toBe(
        '<div class="table-scroll"><table class="listing-details-table"><tbody></tbody></table></div>',
      );
    });

    test("renders a single row", () => {
      const rows: DetailRow[] = [{ key: "Name", value: "Alice" }];
      expect(String(DetailTable({ rows }))).toBe(
        '<div class="table-scroll"><table class="listing-details-table"><tbody><tr><th>Name</th><td>Alice</td></tr></tbody></table></div>',
      );
    });

    test("renders multiple rows", () => {
      const rows: DetailRow[] = [
        { key: "A", value: "1" },
        { key: "B", value: "2" },
      ];
      expect(String(DetailTable({ rows }))).toBe(
        '<div class="table-scroll"><table class="listing-details-table"><tbody><tr><th>A</th><td>1</td></tr><tr><th>B</th><td>2</td></tr></tbody></table></div>',
      );
    });

    test("renders custom children before mapped rows", () => {
      const rows: DetailRow[] = [{ key: "Shared", value: "Second" }];
      const children = LabelledRow({
        children: "First",
        label: "Custom",
      });

      expect(String(DetailTable({ children, rows }))).toBe(
        '<div class="table-scroll"><table class="listing-details-table"><tbody><tr><th>Custom</th><td>First</td></tr><tr><th>Shared</th><td>Second</td></tr></tbody></table></div>',
      );
    });
  });

  describe("countCheckedIn", () => {
    test("returns 0 for empty list", () => {
      expect(countCheckedIn([])).toBe(0);
    });

    test("sums quantity of checked-in attendees", () => {
      const attendees = [
        testAttendee({ checked_in: true, id: 1, quantity: 2 }),
        testAttendee({ checked_in: false, id: 2, quantity: 3 }),
        testAttendee({ checked_in: true, id: 3, quantity: 1 }),
      ];
      expect(countCheckedIn(attendees)).toBe(3);
    });
  });

  describe("countCheckedInRows", () => {
    test("returns 0 for empty list", () => {
      expect(countCheckedInRows([])).toBe(0);
    });

    test("counts rows regardless of quantity", () => {
      const attendees = [
        testAttendee({ checked_in: true, id: 1, quantity: 5 }),
        testAttendee({ checked_in: false, id: 2, quantity: 1 }),
        testAttendee({ checked_in: true, id: 3, quantity: 3 }),
      ];
      expect(countCheckedInRows(attendees)).toBe(2);
    });
  });

  describe("sumQuantity", () => {
    test("returns 0 for empty list", () => {
      expect(sumQuantity([])).toBe(0);
    });

    test("sums quantity across attendees", () => {
      const attendees = [
        testAttendee({ id: 1, quantity: 2 }),
        testAttendee({ id: 2, quantity: 3 }),
      ];
      expect(sumQuantity(attendees)).toBe(5);
    });
  });

  describe("calculateTotalRevenue", () => {
    test("returns 0 for empty list", () => {
      expect(calculateTotalRevenue([])).toBe(0);
    });

    test("sums price_paid across attendees", () => {
      const attendees = [
        testAttendee({ id: 1, price_paid: "1000" }),
        testAttendee({ id: 2, price_paid: "2500" }),
      ];
      expect(calculateTotalRevenue(attendees)).toBe(3500);
    });

    test("reads stored revenue as base-10", () => {
      expect(
        calculateTotalRevenue([testAttendee({ price_paid: "0x10" })]),
      ).toBe(0);
    });
  });

  describe("answer summary rows", () => {
    test("returns empty array when questionData is undefined", () => {
      expect(answerSummaryRows(undefined)).toEqual([]);
    });

    test("returns empty array when no questions", () => {
      expect(
        answerSummaryRows({
          attendeeAnswerMap: new Map(),
          questions: [],
        }),
      ).toEqual([]);
    });

    test("returns DetailRows with answer counts", () => {
      const rows = answerSummaryRows(sizeQuestionAnswerData());
      expect(rows).toEqual([{ key: "Size?", value: "Small (2), Large (1)" }]);
    });

    test("shows zero for answers with no selections", () => {
      const rows = answerSummaryRows(unselectedAnswerQuestionData());
      expect(rows).toEqual([{ key: "Q?", value: "A (0)" }]);
    });

    test("escapes operator-authored question and answer HTML", () => {
      const rows = answerSummaryRows({
        attendeeAnswerMap: new Map([[1, [10]]]),
        questions: [
          testQuestion({
            answers: [testAnswer({ text: '<img src="x">' })],
            text: "<strong>Question?</strong>",
          }),
        ],
      });

      expect(String(DetailTable({ rows }))).toContain(
        "<th>&lt;strong&gt;Question?&lt;/strong&gt;</th><td>&lt;img src=&quot;x&quot;&gt; (1)</td>",
      );
    });
  });

  describe("buildSharedDetailRows", () => {
    /** Build the unpaid-listing detail rows for a count/capacity and return the
     * rendered "Attendees" row value. */
    const attendeesRowValue = (
      attendeeCount: number,
      maxCapacity: number,
    ): string =>
      String(
        buildSharedDetailRows({
          attendeeCount,
          attendees: [],
          hasPaidListing: false,
          maxCapacity,
        }).find((r) => r.key === "Attendees")!.value,
      );

    test("includes attendees row with count only when no capacity", () => {
      expect(attendeesRowValue(5, 0)).toBe("5");
    });

    test("includes attendees row with count, capacity, and remain", () => {
      const value = attendeesRowValue(5, 20);
      expect(value).toContain("5 / 20");
      expect(value).toContain("15 remain");
    });

    test("uses a capacity of one", () => {
      expect(attendeesRowValue(0, 1)).toBe(
        '<span class="">0 / 1 — 1 remain</span>',
      );
    });

    test("shows danger-text when near capacity", () => {
      expect(attendeesRowValue(19, 20)).toContain("danger-text");
    });

    test("does not show danger-text when well below capacity", () => {
      expect(attendeesRowValue(5, 20)).not.toContain("danger-text");
    });

    test("does not show danger-text when no capacity set", () => {
      expect(attendeesRowValue(100, 0)).not.toContain("danger-text");
    });

    test("skips attendees row when skipAttendees is true", () => {
      const rows = buildSharedDetailRows({
        attendeeCount: 5,
        attendees: [],
        hasPaidListing: false,
        maxCapacity: 0,
        skipAttendees: true,
      });
      expect(rows.find((r) => r.key === "Attendees")).toBeUndefined();
    });

    test("shows single checked-in row when no multi-quantity", () => {
      const attendees = [
        testAttendee({ checked_in: true, id: 1, quantity: 1 }),
        testAttendee({ checked_in: false, id: 2, quantity: 1 }),
      ];
      const rows = buildSharedDetailRows({
        attendeeCount: 2,
        attendees,
        hasPaidListing: false,
        maxCapacity: 0,
      });
      const checkedIn = rows.find((r) => r.key === "Checked In");
      expect(checkedIn).toBeDefined();
      expect(checkedIn!.value).toContain("1 / 2");
      expect(checkedIn!.value).toContain("1 remain");
    });

    test("excludes no-quantity rows from the check-in stats", () => {
      // One real (checked-in) line + one no-quantity sentinel. The ghost must
      // not inflate the row total or force a spurious multi-quantity split.
      const attendees = [
        testAttendee({ checked_in: true, id: 1, quantity: 1 }),
        testAttendee({ checked_in: false, id: 2, quantity: 0 }),
      ];
      const rows = buildSharedDetailRows({
        attendeeCount: 1,
        attendees,
        hasPaidListing: false,
        maxCapacity: 0,
      });
      // Single "Checked In" row (no split), counting only the real line.
      const checkedIn = rows.find((r) => r.key === "Checked In");
      expect(checkedIn!.value).toContain("1 / 1");
      expect(rows.find((r) => r.key === "Tickets Checked In")).toBeUndefined();
    });

    test("shows split checked-in rows for multi-quantity", () => {
      const attendees = [
        testAttendee({ checked_in: true, id: 1, quantity: 3 }),
        testAttendee({ checked_in: false, id: 2, quantity: 2 }),
      ];
      const rows = buildSharedDetailRows({
        attendeeCount: 5,
        attendees,
        hasPaidListing: false,
        maxCapacity: 0,
      });
      expect(rows.find((r) => r.key === "Tickets Checked In")).toBeDefined();
      expect(rows.find((r) => r.key === "Attendees Checked In")).toBeDefined();
      expect(rows.find((r) => r.key === "Checked In")).toBeUndefined();
    });

    test("includes revenue row when hasPaidListing is true", () => {
      const attendees = [testAttendee({ price_paid: "1000" })];
      const rows = buildSharedDetailRows({
        attendeeCount: 1,
        attendees,
        hasPaidListing: true,
        maxCapacity: 0,
      });
      const revenue = rows.find((r) => r.key === "Total Revenue");
      expect(revenue?.value).toBe("£10");
    });

    test("uses an authoritative zero revenue total", () => {
      const rows = buildSharedDetailRows({
        attendeeCount: 1,
        attendees: [testAttendee({ price_paid: "1000" })],
        hasPaidListing: true,
        maxCapacity: 0,
        revenue: 0,
      });
      expect(rows.find((r) => r.key === "Total Revenue")?.value).toBe("£0");
    });

    test("keeps authoritative revenue for an unpaid listing", () => {
      const rows = buildSharedDetailRows({
        attendeeCount: 1,
        attendees: [testAttendee({ price_paid: "1000" })],
        hasPaidListing: false,
        maxCapacity: 0,
        revenue: 2500,
      });
      expect(rows.find((r) => r.key === "Total Revenue")?.value).toBe("£25");
    });

    test("excludes revenue row when hasPaidListing is false", () => {
      const rows = buildSharedDetailRows({
        attendeeCount: 1,
        attendees: [testAttendee()],
        hasPaidListing: false,
        maxCapacity: 0,
      });
      expect(rows.find((r) => r.key === "Total Revenue")).toBeUndefined();
    });

    test("does not read attendee revenue for an unpaid listing", () => {
      const attendee = testAttendee();
      Object.defineProperty(attendee, "price_paid", {
        get: () => {
          throw new Error("price_paid was read");
        },
      });

      expect(
        buildSharedDetailRows({
          attendeeCount: 1,
          attendees: [attendee],
          hasPaidListing: false,
          maxCapacity: 0,
        }).find((r) => r.key === "Total Revenue"),
      ).toBeUndefined();
    });

    test("includes question summary rows", () => {
      const rows = buildSharedDetailRows({
        attendeeCount: 0,
        attendees: [],
        hasPaidListing: false,
        maxCapacity: 0,
        questionData: singleAnswerSizeQuestionData(),
      });
      expect(rows.find((r) => r.key === "Size?")).toBeDefined();
    });

    test("appends labelSuffix to keys", () => {
      const rows = buildSharedDetailRows({
        attendeeCount: 1,
        attendees: [testAttendee()],
        hasPaidListing: false,
        labelSuffix: " (total)",
        maxCapacity: 0,
      });
      expect(rows.find((r) => r.key === "Attendees (total)")).toBeDefined();
      expect(rows.find((r) => r.key === "Checked In (total)")).toBeDefined();
    });
  });
});
