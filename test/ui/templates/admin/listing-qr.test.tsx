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

    assertStringIncludes(html, 'class="active" href="/admin/"');
    assertStringIncludes(html, 'href="/admin/listing/12"');
  });

  test("names the listing and links to it in the panel heading", () => {
    const html = renderPanel();

    assertStringIncludes(html, "Booking QR code —");
    assertStringIncludes(html, 'href="/admin/listing/12"');
    assertStringIncludes(html, 'class="prose"');
  });

  test("describes the direct-checkout condition for both states", () => {
    const direct = renderPanel({ canDirectCheckout: true });
    const indirect = renderPanel({ canDirectCheckout: false });

    assertStringIncludes(direct, 'class="success-text"');
    assertStringIncludes(direct, "(this is the case)");
    assertStringIncludes(indirect, 'class="danger-text"');
    assertStringIncludes(indirect, "(this is not the case)");
  });

  test("renders a fixed-price override input without an upper bound", () => {
    const html = renderPanel();

    const priceInput = html.match(/<input[^>]*name="value"[^>]*>/)![0];
    assertStringIncludes(priceInput, 'inputmode="decimal"');
    assertStringIncludes(priceInput, 'type="text"');
    assertStringIncludes(priceInput, 'min="0"');
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

    assertStringIncludes(html, 'min="12.00"');
    assertStringIncludes(html, 'max="25.00"');
    assertStringIncludes(html, "Minimum £12, maximum £25");
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
    assertStringIncludes(html, '<option selected value="2026-06-15">');
    // The empty prompt stays first and unselected for the required check.
    assertStringIncludes(html, 'value="">');
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

    assertStringIncludes(html, 'class="qr-result"');
    assertStringIncludes(html, 'data-qr-refresh="/admin/listing/12/qr.json"');
    assertStringIncludes(html, 'data-qr-refresh-form="/admin/listing/12/qr"');
    assertStringIncludes(html, 'class="qr-code" data-qr-svg>');
    assertStringIncludes(html, "<svg>encoded</svg>");
    assertStringIncludes(html, "data-qr-link");
    assertStringIncludes(html, 'type="text"');
    assertStringIncludes(html, 'value="https://site.example/t?qr=abc123"');
  });

  test("renders a rejected generate's error and the submitted values", () => {
    const html = renderPanel({ error: "Enter a valid price" });

    assertStringIncludes(html, "Enter a valid price");
    assertStringIncludes(html, 'value="19.99"');
  });
});
