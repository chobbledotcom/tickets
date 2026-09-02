import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  type AdminListingQrPageOptions,
  adminListingQrPage,
} from "#templates/admin/listing-qr.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const render = (over: Partial<AdminListingQrPageOptions> = {}): string =>
  adminListingQrPage({
    bookableDates: [],
    canDirectCheckout: false,
    listing: testListingWithCount({ id: 7, name: "Gala Night" }),
    session: OWNER_SESSION,
    values: { customer_name: "", date: "", quantity: "1", value: "" },
    ...over,
  });

describe("adminListingQrPage", () => {
  beforeAll(setupAdminPageTest);

  test("titles the page with the listing it is for", () => {
    expect(render()).toContain("Gala Night");
  });

  test("links back to the listing's own admin page", () => {
    expect(render()).toContain('href="/admin/listing/7"');
  });

  test("re-fills the form with the values that were submitted", () => {
    const html = render({
      values: {
        customer_name: "Ada",
        date: "2026-07-04",
        quantity: "3",
        value: "12.50",
      },
    });
    expect(html).toContain('value="Ada"');
    expect(html).toContain('value="3"');
    expect(html).toContain('value="12.50"');
  });

  test("shows an error when one is given", () => {
    expect(render({ error: "That price is too low" })).toContain(
      "That price is too low",
    );
  });

  test("shows no error when none is given", () => {
    expect(render()).not.toContain("That price is too low");
  });

  test("shows the generated code and its link on success", () => {
    const html = render({
      result: { svg: "<svg id='the-code'></svg>", url: "https://x.test/t/abc" },
    });
    expect(html).toContain("the-code");
    expect(html).toContain("https://x.test/t/abc");
  });

  test("offers the bookable dates a daily listing was given", () => {
    const html = render({
      bookableDates: ["2026-07-04"],
      listing: testListingWithCount({
        id: 7,
        listing_type: "daily",
        name: "Gala Night",
      }),
    });
    expect(html).toContain("2026-07-04");
  });

  test("asks for no date on a listing that is not booked by the day", () => {
    expect(render({ bookableDates: ["2026-07-04"] })).not.toContain(
      "2026-07-04",
    );
  });
});
