import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatCurrency } from "#shared/currency.ts";
import {
  AvailabilityChecker,
  type AvailabilityRow,
} from "#templates/admin/availability-checker.tsx";

const render = (rows: AvailabilityRow[], date: string | null): string =>
  String(<AvailabilityChecker date={date} rows={rows} />);

describe("AvailabilityChecker", () => {
  test("renders the empty state without selection actions", () => {
    const html = render([], "2027-03-14");

    expect(html).toBe(
      '<details class="availability-checker" data-availability-checker><summary>Check availability</summary><div class="availability-checker-body"><p><em>No bookable listings.</em></p></div></details>',
    );
  });

  test("sorts listings and renders every price and availability state", () => {
    const html = render(
      [
        {
          canPayMore: false,
          id: 30,
          name: "Zulu",
          remaining: 0,
          total: 4,
          unitPrice: 1250,
        },
        {
          canPayMore: true,
          id: 10,
          name: "Alpha",
          remaining: 3,
          total: 5,
          unitPrice: 0,
        },
        {
          canPayMore: true,
          id: 20,
          name: "Bravo",
          remaining: 1,
          total: 2,
          unitPrice: 500,
        },
      ],
      "2027-03-14",
    );

    expect(html).toContain(
      '<form action="/admin/attendees/new" class="selectable-form" method="get">',
    );
    expect(html).toContain(
      '<input name="start_date" type="hidden" value="2027-03-14">',
    );
    expect(html).toContain('<table class="availability-table">');
    expect(html.indexOf(">Alpha</a>")).toBeLessThan(html.indexOf(">Bravo</a>"));
    expect(html.indexOf(">Bravo</a>")).toBeLessThan(html.indexOf(">Zulu</a>"));
    expect(html).toContain(
      '<input aria-label="Select Alpha" class="order-select" id="select_10" name="select_10" type="checkbox" value="1">',
    );
    expect(html).toContain('<td class="col-quantity">3/5</td>');
    expect(html).toContain('<td class="col-quantity danger">0/4</td>');
    expect(html).toContain('<td class="col-amount">Free</td>');
    expect(html).toContain(
      `<td class="col-amount">From ${formatCurrency(500)}</td>`,
    );
    expect(html).toContain(
      `<td class="col-amount">${formatCurrency(1250)}</td>`,
    );
  });

  test("renders both create actions for selected listings", () => {
    const html = render(
      [
        {
          canPayMore: false,
          id: 8,
          name: "Workshop",
          remaining: 2,
          total: 6,
          unitPrice: 900,
        },
      ],
      null,
    );

    expect(html).not.toContain('name="start_date"');
    expect(html).toContain('<button class="order-cart" type="submit">');
    expect(html).toContain(
      '<button class="order-cart" formaction="/admin/servicing/new" type="submit">',
    );
    expect(html).toContain(
      '<span class="order-cart-label">Create Attendee</span>',
    );
    expect(html).toContain(
      '<span class="order-cart-label">Create Service Event</span>',
    );
    expect(html.match(/class="order-cart-count"/g)).toHaveLength(2);
  });
});
