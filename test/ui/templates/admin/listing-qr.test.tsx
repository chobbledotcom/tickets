import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminListingQrPage,
  ListingQrPanel,
} from "#templates/admin/listing-qr.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import type { ListingWithCount } from "#types";

describe("the listing booking-QR page", () => {
  beforeAll(setupAdminPageTest);

  const listing = (
    overrides: Partial<ListingWithCount> = {},
  ): ListingWithCount =>
    ({
      can_pay_more: false,
      id: 12,
      listing_type: "daily",
      max_price: 2500,
      max_quantity: 4,
      min_quantity: 1,
      name: "QR Listing",
      unit_price: 1200,
      ...overrides,
    }) as ListingWithCount;

  const values = {
    customer_name: "Ada",
    date: "2026-06-15",
    quantity: "2",
    value: "19.99",
  };

  const renderPanel = (
    overrides: Partial<Parameters<typeof ListingQrPanel>[0]> = {},
  ): string =>
    String(
      ListingQrPanel({
        bookableDates: ["2026-06-15", "2026-06-16"],
        canDirectCheckout: false,
        listing: listing(),
        values,
        ...overrides,
      }),
    );

  test("hands the QR panel to the admin page under the Home nav", () => {
    const html = adminListingQrPage({
      bookableDates: [],
      canDirectCheckout: false,
      listing: listing(),
      session: OWNER_SESSION,
      values,
    });

    expectIncludesAll(html, [
      'class="active" href="/admin/"',
      'href="/admin/listing/12"',
    ]);
  });

  test("names the listing and links to it in the panel heading", () => {
    const html = renderPanel();

    expectIncludesAll(html, [
      "Booking QR code —",
      'href="/admin/listing/12"',
      'class="prose"',
    ]);
  });

  test("describes the direct-checkout condition for both states", () => {
    const direct = renderPanel({ canDirectCheckout: true });
    const indirect = renderPanel({ canDirectCheckout: false });

    expectIncludesAll(direct, ['class="success-text"', "(this is the case)"]);
    expectIncludesAll(indirect, [
      'class="danger-text"',
      "(this is not the case)",
    ]);
  });

  test("renders a fixed-price override input without an upper bound", () => {
    const html = renderPanel();

    const priceInput = html.match(/<input[^>]*name="value"[^>]*>/)![0];
    expectIncludesAll(priceInput, [
      'inputmode="decimal"',
      'type="text"',
      'min="0"',
    ]);
    assert(!priceInput.includes('max="'));
    assertStringIncludes(
      html,
      "Overrides the listed per-unit price of £12 for this booking",
    );
  });

  test("caps a pay-what-you-want listing at its configured range", () => {
    const html = renderPanel({
      listing: listing({ can_pay_more: true }),
    });

    expectIncludesAll(html, [
      'min="12.00"',
      'max="25.00"',
      "Minimum £12, maximum £25",
    ]);
  });

  test("collects the customer name and quantity", () => {
    const html = renderPanel();

    expect(html).toMatch(/<input[^>]*name="customer_name"[^>]*type="text"/);
    assertStringIncludes(html, 'value="Ada"');
    expect(html).toMatch(/<input[^>]*name="quantity"[^>]*type="number"/);
    expect(html).toMatch(/<input[^>]*max="4"[^>]*min="1"/);
    assertStringIncludes(html, 'value="2"');
  });

  test("dates are a required dropdown, and the saved date stays selected", () => {
    const html = renderPanel();

    expect(html).toMatch(/<select[^>]*name="date"[^>]*required/);
    expectIncludesAll(html, [
      '<option selected value="2026-06-15">',
      // The empty prompt stays first and unselected for the required check.
      'value="">',
    ]);
  });

  test("a daily-only form shows no date dropdown for other listing types", () => {
    const html = renderPanel({
      listing: listing({ listing_type: "standard" }),
    });

    assert(!html.includes('name="date"'));
  });

  test("shows the generated QR with its copyable link and refresh hooks", () => {
    const html = renderPanel({
      result: {
        svg: "<svg>encoded</svg>",
        url: "https://site.example/t?qr=abc123",
      },
    });

    expectIncludesAll(html, [
      'class="qr-result"',
      'data-qr-refresh="/admin/listing/12/qr.json"',
      'data-qr-refresh-form="/admin/listing/12/qr"',
      'class="qr-code" data-qr-svg>',
      "<svg>encoded</svg>",
      "data-qr-link",
      'type="text"',
      'value="https://site.example/t?qr=abc123"',
    ]);
  });

  test("renders a rejected generate's error and the submitted values", () => {
    const html = renderPanel({ error: "Enter a valid price" });

    expectIncludesAll(html, ["Enter a valid price", 'value="19.99"']);
  });
});
