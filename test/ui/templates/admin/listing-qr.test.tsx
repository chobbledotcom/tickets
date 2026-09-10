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

    expect(html).toContain('class="active" href="/admin/"');
    expect(html).toContain('href="/admin/listing/12"');
  });

  test("names the listing and links to it in the panel heading", () => {
    const html = renderPanel();

    expect(html).toContain("Booking QR code —");
    expect(html).toContain('href="/admin/listing/12"');
    expect(html).toContain('class="prose"');
  });

  test("describes the direct-checkout condition for both states", () => {
    const direct = renderPanel({ canDirectCheckout: true });
    const indirect = renderPanel({ canDirectCheckout: false });

    expect(direct).toContain('class="success-text"');
    expect(direct).toContain("(this is the case)");
    expect(indirect).toContain('class="danger-text"');
    expect(indirect).toContain("(this is not the case)");
  });

  test("renders a fixed-price override input without an upper bound", () => {
    const html = renderPanel();

    const priceInput = html.match(/<input[^>]*name="value"[^>]*>/)![0];
    expect(priceInput).toContain('inputmode="decimal"');
    expect(priceInput).toContain('type="text"');
    expect(priceInput).toContain('min="0"');
    expect(priceInput).not.toContain('max="');
    expect(html).toContain(
      "Overrides the ticket price of £12 for this booking",
    );
  });

  test("caps a pay-what-you-want listing at its configured range", () => {
    const html = renderPanel({
      listing: listing({ can_pay_more: true }),
    });

    expect(html).toContain('min="12.00"');
    expect(html).toContain('max="25.00"');
    expect(html).toContain("Minimum £12, maximum £25");
  });

  test("collects the customer name and quantity", () => {
    const html = renderPanel();

    expect(html).toMatch(/<input[^>]*name="customer_name"[^>]*type="text"/);
    expect(html).toContain('value="Ada"');
    expect(html).toMatch(/<input[^>]*name="quantity"[^>]*type="number"/);
    expect(html).toMatch(/<input[^>]*max="4"[^>]*min="1"/);
    expect(html).toContain('value="2"');
  });

  test("dates are a required dropdown, and the saved date stays selected", () => {
    const html = renderPanel();

    expect(html).toMatch(/<select[^>]*name="date"[^>]*required/);
    expect(html).toContain('<option selected value="2026-06-15">');
    // The empty prompt stays first and unselected for the required check.
    expect(html).toContain('value="">');
  });

  test("a daily-only form shows no date dropdown for other listing types", () => {
    const html = renderPanel({
      listing: listing({ listing_type: "standard" }),
    });

    expect(html).not.toContain('name="date"');
  });

  test("shows the generated QR with its copyable link and refresh hooks", () => {
    const html = renderPanel({
      result: {
        svg: "<svg>encoded</svg>",
        url: "https://site.example/t?qr=abc123",
      },
    });

    expect(html).toContain('class="qr-result"');
    expect(html).toContain('data-qr-refresh="/admin/listing/12/qr.json"');
    expect(html).toContain('data-qr-refresh-form="/admin/listing/12/qr"');
    expect(html).toContain('class="qr-code" data-qr-svg>');
    expect(html).toContain("<svg>encoded</svg>");
    expect(html).toContain("data-qr-link");
    expect(html).toContain('type="text"');
    expect(html).toContain('value="https://site.example/t?qr=abc123"');
  });

  test("renders a rejected generate's error and the submitted values", () => {
    const html = renderPanel({ error: "Enter a valid price" });

    expect(html).toContain("Enter a valid price");
    expect(html).toContain('value="19.99"');
  });
});
