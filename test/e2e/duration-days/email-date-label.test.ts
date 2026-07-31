import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildTemplateData } from "#shared/email-renderer.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { makeTestEntry } from "#test-utils/factories.ts";

describeWithEnv(
  "e2e: multi-day bookings — email date range label",
  { db: true },
  () => {
    describe("display: email template date_range_label", () => {
      const labelFor = async (
        listing: Parameters<typeof makeTestEntry>[0],
        attendee: Parameters<typeof makeTestEntry>[1],
      ) =>
        (
          await buildTemplateData(
            [makeTestEntry(listing, attendee)],
            "GBP",
            "https://example.com/t/ABC",
          )
        ).entries[0]!.attendee.date_range_label;

      test("multi-day booking shows en-dash range", async () => {
        // The label reflects the booking's stored span (end_date exclusive), so a
        // 3-day booking from the 12th ends (exclusive) on the 15th.
        expect(
          await labelFor(
            { duration_days: 3, listing_type: "daily" },
            { date: "2026-06-12", end_date: "2026-06-15" },
          ),
        ).toBe("12\u201314 June 2026");
      });

      test("single-day booking shows full date", async () => {
        expect(
          await labelFor(
            { duration_days: 1, listing_type: "daily" },
            { date: "2026-06-12" },
          ),
        ).toContain("12 June");
      });

      test("no-date booking shows empty string", async () => {
        expect(await labelFor({}, { date: null })).toBe("");
      });
    });
  },
);
