import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { squareApi } from "#shared/square.ts";
import {
  type FetchCall,
  installMockFetch,
  jsonResponse,
} from "#test/shared/square/mock-fetch.ts";
import { describeSquare } from "#test/test-utils/square/harness.ts";

describeSquare(() => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: { calls: FetchCall[] };

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await settings.update.square.accessToken("EAAAl_payment_list");
    await settings.update.square.sandbox(true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("lists and maps one hundred Square payments with a cursor", async () => {
    mockFetch = installMockFetch(() =>
      Promise.resolve(
        jsonResponse({
          cursor: "next-page",
          payments: Array.from({ length: 100 }, (_, index) => ({
            amount_money: { amount: 25, currency: "GBP" },
            created_at: "2026-07-26T12:00:00.000Z",
            id: `payment-${index}`,
            location_id: "location-one",
            order_id: "order-one",
            status: "COMPLETED",
          })),
        }),
      ),
    );
    const client = await squareApi.getSquareClient();
    if (client === null) throw new Error("Expected Square client");

    const page = await client.payments.list({
      cursor: "current-page",
      locationId: "location-one",
    });

    expect(page.cursor).toBe("next-page");
    expect(page.payments).toHaveLength(100);
    expect(page.payments[39]).toMatchObject({
      amountMoney: { amount: 25n, currency: "GBP" },
      id: "payment-39",
      orderId: "order-one",
    });
    expect(mockFetch.calls[0]?.args[0]).toBe(
      "https://connect.squareupsandbox.com/v2/payments?limit=100&location_id=location-one&sort_order=ASC&cursor=current-page",
    );
  });

  test("reads a last page that lists nothing and goes no further", async () => {
    // Square leaves both fields out when there is nothing more to send.
    installMockFetch(() => Promise.resolve(jsonResponse({})));
    const client = await squareApi.getSquareClient();
    if (client === null) throw new Error("Expected Square client");

    const page = await client.payments.list({ locationId: "location-one" });

    expect(page).toEqual({ payments: [] });
  });
});
