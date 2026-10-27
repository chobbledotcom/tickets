import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { AssignUndatedDayCard } from "#templates/admin/listings/assign-day-card.tsx";

const card = (extra: Record<string, unknown> = {}) => ({
  chosen: "",
  count: 2,
  dates: ["2026-11-05"],
  noDates: false,
  noneFits: false,
  ...extra,
});

describe("the assign-day card", () => {
  test("names the bookings without a day and offers the dates", () => {
    const html = String(AssignUndatedDayCard({ card: card() }));
    // The heading and its copy share a prose block; the date field follows
    // outside it, as a control rather than prose copy.
    expect(
      html.includes('<div class="prose"><h2>2 bookings have no day</h2>'),
    ).toBe(true);
    expect(html.includes('</p></div><label for="assign_undated_to">')).toBe(
      true,
    );
    expect(html.includes("2 bookings have no day")).toBe(true);
    expect(html.includes("Move these bookings to")).toBe(true);
    expect(html.includes('value="2026-11-05"')).toBe(true);
    // The select submits under the field the save reads the day from.
    expect(html.includes('name="assign_undated_to"')).toBe(true);
  });

  test("says plainly when the listing has no bookable dates", () => {
    const html = String(
      AssignUndatedDayCard({
        card: card({ dates: [], noDates: true }),
      }),
    );
    expect(html.includes("This listing has no bookable dates")).toBe(true);
    // The plain-saying paragraph sits inside the prose block: the prose div
    // and then the notice close right after it.
    expect(
      html.endsWith("no date to give these bookings.</p></div></div>"),
    ).toBe(true);
    expect(html.includes("Move these bookings to")).toBe(false);
  });

  test("says plainly when no date can hold the bookings", () => {
    const html = String(
      AssignUndatedDayCard({ card: card({ noneFits: true }) }),
    );
    expect(html.includes("No date has room for all 2 bookings")).toBe(true);
    expect(html.includes("Move these bookings to")).toBe(false);
  });
});
