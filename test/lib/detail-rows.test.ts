import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildAnswerSummaryRows,
  buildSharedDetailRows,
  calculateTotalRevenue,
  countCheckedIn,
  countCheckedInRows,
  type DetailRow,
  renderDetailRows,
  sumQuantity,
} from "#templates/admin/detail-rows.tsx";
import { testAttendee } from "#test-utils";

describe("detail-rows", () => {
  describe("renderDetailRows", () => {
    test("renders empty string for empty array", () => {
      expect(renderDetailRows([])).toBe("");
    });

    test("renders a single row", () => {
      const rows: DetailRow[] = [{ key: "Name", value: "Alice" }];
      expect(renderDetailRows(rows)).toBe(
        "<tr><th>Name</th><td>Alice</td></tr>",
      );
    });

    test("renders multiple rows", () => {
      const rows: DetailRow[] = [
        { key: "A", value: "1" },
        { key: "B", value: "2" },
      ];
      const html = renderDetailRows(rows);
      expect(html).toBe(
        "<tr><th>A</th><td>1</td></tr><tr><th>B</th><td>2</td></tr>",
      );
    });
  });

  describe("countCheckedIn", () => {
    test("returns 0 for empty list", () => {
      expect(countCheckedIn([])).toBe(0);
    });

    test("sums quantity of checked-in attendees", () => {
      const attendees = [
        testAttendee({ id: 1, checked_in: true, quantity: 2 }),
        testAttendee({ id: 2, checked_in: false, quantity: 3 }),
        testAttendee({ id: 3, checked_in: true, quantity: 1 }),
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
        testAttendee({ id: 1, checked_in: true, quantity: 5 }),
        testAttendee({ id: 2, checked_in: false, quantity: 1 }),
        testAttendee({ id: 3, checked_in: true, quantity: 3 }),
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
  });

  describe("buildAnswerSummaryRows", () => {
    test("returns empty array when questionData is undefined", () => {
      expect(buildAnswerSummaryRows(undefined)).toEqual([]);
    });

    test("returns empty array when no questions", () => {
      expect(
        buildAnswerSummaryRows({
          questions: [],
          attendeeAnswerMap: new Map(),
        }),
      ).toEqual([]);
    });

    test("returns DetailRows with answer counts", () => {
      const rows = buildAnswerSummaryRows({
        questions: [
          {
            id: 1,
            text: "Size?",
            answers: [
              { id: 10, question_id: 1, text: "Small", sort_order: 0 },
              { id: 11, question_id: 1, text: "Large", sort_order: 1 },
            ],
          },
        ],
        attendeeAnswerMap: new Map([
          [1, [10]],
          [2, [10]],
          [3, [11]],
        ]),
      });
      expect(rows).toEqual([{ key: "Size?", value: "Small (2), Large (1)" }]);
    });

    test("shows zero for answers with no selections", () => {
      const rows = buildAnswerSummaryRows({
        questions: [
          {
            id: 1,
            text: "Q?",
            answers: [{ id: 10, question_id: 1, text: "A", sort_order: 0 }],
          },
        ],
        attendeeAnswerMap: new Map(),
      });
      expect(rows).toEqual([{ key: "Q?", value: "A (0)" }]);
    });
  });

  describe("buildSharedDetailRows", () => {
    test("includes attendees row with count only when no capacity", () => {
      const rows = buildSharedDetailRows({
        attendees: [],
        attendeeCount: 5,
        maxCapacity: 0,
        hasPaidEvent: false,
      });
      const attendeeRow = rows.find((r) => r.key === "Attendees");
      expect(attendeeRow).toBeDefined();
      expect(attendeeRow?.value).toBe("5");
    });

    test("includes attendees row with count, capacity, and remain", () => {
      const rows = buildSharedDetailRows({
        attendees: [],
        attendeeCount: 5,
        maxCapacity: 20,
        hasPaidEvent: false,
      });
      const attendeeRow = rows.find((r) => r.key === "Attendees");
      expect(attendeeRow?.value).toContain("5 / 20");
      expect(attendeeRow?.value).toContain("15 remain");
    });

    test("shows danger-text when near capacity", () => {
      const rows = buildSharedDetailRows({
        attendees: [],
        attendeeCount: 19,
        maxCapacity: 20,
        hasPaidEvent: false,
      });
      const attendeeRow = rows.find((r) => r.key === "Attendees");
      expect(attendeeRow?.value).toContain("danger-text");
    });

    test("does not show danger-text when well below capacity", () => {
      const rows = buildSharedDetailRows({
        attendees: [],
        attendeeCount: 5,
        maxCapacity: 20,
        hasPaidEvent: false,
      });
      const attendeeRow = rows.find((r) => r.key === "Attendees");
      expect(attendeeRow?.value).not.toContain("danger-text");
    });

    test("does not show danger-text when no capacity set", () => {
      const rows = buildSharedDetailRows({
        attendees: [],
        attendeeCount: 100,
        maxCapacity: 0,
        hasPaidEvent: false,
      });
      const attendeeRow = rows.find((r) => r.key === "Attendees");
      expect(attendeeRow?.value).not.toContain("danger-text");
    });

    test("skips attendees row when skipAttendees is true", () => {
      const rows = buildSharedDetailRows({
        attendees: [],
        attendeeCount: 5,
        maxCapacity: 0,
        hasPaidEvent: false,
        skipAttendees: true,
      });
      expect(rows.find((r) => r.key === "Attendees")).toBeUndefined();
    });

    test("shows single checked-in row when no multi-quantity", () => {
      const attendees = [
        testAttendee({ id: 1, checked_in: true, quantity: 1 }),
        testAttendee({ id: 2, checked_in: false, quantity: 1 }),
      ];
      const rows = buildSharedDetailRows({
        attendees,
        attendeeCount: 2,
        maxCapacity: 0,
        hasPaidEvent: false,
      });
      const checkedIn = rows.find((r) => r.key === "Checked In");
      expect(checkedIn).toBeDefined();
      expect(checkedIn?.value).toContain("1 / 2");
      expect(checkedIn?.value).toContain("1 remain");
    });

    test("shows split checked-in rows for multi-quantity", () => {
      const attendees = [
        testAttendee({ id: 1, checked_in: true, quantity: 3 }),
        testAttendee({ id: 2, checked_in: false, quantity: 2 }),
      ];
      const rows = buildSharedDetailRows({
        attendees,
        attendeeCount: 5,
        maxCapacity: 0,
        hasPaidEvent: false,
      });
      expect(rows.find((r) => r.key === "Tickets Checked In")).toBeDefined();
      expect(rows.find((r) => r.key === "Attendees Checked In")).toBeDefined();
      expect(rows.find((r) => r.key === "Checked In")).toBeUndefined();
    });

    test("includes revenue row when hasPaidEvent is true", () => {
      const attendees = [testAttendee({ price_paid: "1000" })];
      const rows = buildSharedDetailRows({
        attendees,
        attendeeCount: 1,
        maxCapacity: 0,
        hasPaidEvent: true,
      });
      const revenue = rows.find((r) => r.key === "Total Revenue");
      expect(revenue).toBeDefined();
    });

    test("excludes revenue row when hasPaidEvent is false", () => {
      const rows = buildSharedDetailRows({
        attendees: [testAttendee()],
        attendeeCount: 1,
        maxCapacity: 0,
        hasPaidEvent: false,
      });
      expect(rows.find((r) => r.key === "Total Revenue")).toBeUndefined();
    });

    test("includes question summary rows", () => {
      const rows = buildSharedDetailRows({
        attendees: [],
        attendeeCount: 0,
        maxCapacity: 0,
        hasPaidEvent: false,
        questionData: {
          questions: [
            {
              id: 1,
              text: "Size?",
              answers: [{ id: 10, question_id: 1, text: "S", sort_order: 0 }],
            },
          ],
          attendeeAnswerMap: new Map(),
        },
      });
      expect(rows.find((r) => r.key === "Size?")).toBeDefined();
    });

    test("appends labelSuffix to keys", () => {
      const rows = buildSharedDetailRows({
        attendees: [testAttendee()],
        attendeeCount: 1,
        maxCapacity: 0,
        hasPaidEvent: false,
        labelSuffix: " (total)",
      });
      expect(rows.find((r) => r.key === "Attendees (total)")).toBeDefined();
      expect(rows.find((r) => r.key === "Checked In (total)")).toBeDefined();
    });
  });
});
