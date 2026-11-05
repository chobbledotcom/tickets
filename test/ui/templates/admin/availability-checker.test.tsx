import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatCurrency } from "#shared/currency.ts";
import {
  AvailabilityChecker,
  type AvailabilityRow,
} from "#templates/admin/availability-checker.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";

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
          unitPrice: 1,
        },
      ],
      "2027-03-14",
    );

    expectIncludesAll(html, [
      '<form action="/admin/attendees/new" class="selectable-form" method="get">',
      '<input name="start_date" type="hidden" value="2027-03-14">',
      '<table class="availability-table">',
    ]);
    expect(html.indexOf(">Alpha</a>")).toBeLessThan(html.indexOf(">Bravo</a>"));
    expect(html.indexOf(">Bravo</a>")).toBeLessThan(html.indexOf(">Zulu</a>"));
    expectIncludesAll(html, [
      '<input aria-label="Select Alpha" class="order-select" id="select_10" name="select_10" type="checkbox" value="1">',
      '<label class="row-select">',
      '<span aria-hidden="true" class="row-select-tick"></span>',
      '<th><span class="visually-hidden">Select</span></th>',
      '<td class="col-quantity">3/5</td>',
      '<td class="col-quantity">1/2</td>',
      '<td class="col-quantity danger">0/4</td>',
      '<td class="col-amount">Free</td>',
      `<td class="col-amount">From ${formatCurrency(1)}</td>`,
      `<td class="col-amount">${formatCurrency(1250)}</td>`,
    ]);
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

    assert(!html.includes('name="start_date"'));
    expectIncludesAll(html, [
      '<div class="order-actions">',
      '<button class="order-cart" type="submit">',
      '<button class="order-cart" formaction="/admin/servicing/new" type="submit">',
      '<span class="order-cart-label">Create Attendee</span>',
      '<span class="order-cart-label">Create Service Event</span>',
    ]);
    expect(html.match(/class="order-cart-count"/g)).toHaveLength(2);
  });
});
