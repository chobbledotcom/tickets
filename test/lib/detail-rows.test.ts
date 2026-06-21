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
  });

  describe("buildAnswerSummaryRows", () => {
    test("returns empty array when questionData is undefined", () => {
      expect(buildAnswerSummaryRows(undefined)).toEqual([]);
    });

    test("returns empty array when no questions", () => {
      expect(
        buildAnswerSummaryRows({
          attendeeAnswerMap: new Map(),
          questions: [],
        }),
      ).toEqual([]);
    });

    test("returns DetailRows with answer counts", () => {
      const rows = buildAnswerSummaryRows({
        attendeeAnswerMap: new Map([
          [1, [10]],
          [2, [10]],
          [3, [11]],
        ]),
        questions: [
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
        ],
      });
      expect(rows).toEqual([{ key: "Size?", value: "Small (2), Large (1)" }]);
    });

    test("shows zero for answers with no selections", () => {
      const rows = buildAnswerSummaryRows({
        attendeeAnswerMap: new Map(),
        questions: [
          {
            answers: [
              {
                active: true,
                id: 10,
                question_id: 1,
                sort_order: 0,
                text: "A",
              },
            ],
            display_type: "radio" as const,
            id: 1,
            text: "Q?",
          },
        ],
      });
      expect(rows).toEqual([{ key: "Q?", value: "A (0)" }]);
    });
  });

  describe("buildSharedDetailRows", () => {
    test("includes attendees row with count only when no capacity", () => {
      const rows = buildSharedDetailRows({
        attendeeCount: 5,
        attendees: [],
        hasPaidListing: false,
        maxCapacity: 0,
      });
      const attendeeRow = rows.find((r) => r.key === "Attendees");
      expect(attendeeRow).toBeDefined();
      expect(attendeeRow!.value).toBe("5");
    });

    test("includes attendees row with count, capacity, and remain", () => {
      const rows = buildSharedDetailRows({
        attendeeCount: 5,
        attendees: [],
        hasPaidListing: false,
        maxCapacity: 20,
      });
      const attendeeRow = rows.find((r) => r.key === "Attendees");
      expect(attendeeRow!.value).toContain("5 / 20");
      expect(attendeeRow!.value).toContain("15 remain");
    });

    test("shows danger-text when near capacity", () => {
      const rows = buildSharedDetailRows({
        attendeeCount: 19,
        attendees: [],
        hasPaidListing: false,
        maxCapacity: 20,
      });
      const attendeeRow = rows.find((r) => r.key === "Attendees");
      expect(attendeeRow!.value).toContain("danger-text");
    });

    test("does not show danger-text when well below capacity", () => {
      const rows = buildSharedDetailRows({
        attendeeCount: 5,
        attendees: [],
        hasPaidListing: false,
        maxCapacity: 20,
      });
      const attendeeRow = rows.find((r) => r.key === "Attendees");
      expect(attendeeRow!.value).not.toContain("danger-text");
    });

    test("does not show danger-text when no capacity set", () => {
      const rows = buildSharedDetailRows({
        attendeeCount: 100,
        attendees: [],
        hasPaidListing: false,
        maxCapacity: 0,
      });
      const attendeeRow = rows.find((r) => r.key === "Attendees");
      expect(attendeeRow!.value).not.toContain("danger-text");
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
      expect(revenue).toBeDefined();
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

    test("includes question summary rows", () => {
      const rows = buildSharedDetailRows({
        attendeeCount: 0,
        attendees: [],
        hasPaidListing: false,
        maxCapacity: 0,
        questionData: {
          attendeeAnswerMap: new Map(),
          questions: [
            {
              answers: [
                {
                  active: true,
                  id: 10,
                  question_id: 1,
                  sort_order: 0,
                  text: "S",
                },
              ],
              display_type: "radio" as const,
              id: 1,
              text: "Size?",
            },
          ],
        },
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
