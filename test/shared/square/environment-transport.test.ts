/* jscpd:ignore-start -- imports */
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

/* jscpd:ignore-end */

describeSquare(() => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: { calls: FetchCall[] };

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await settings.update.square.accessToken("EAAAl_environment_transport");
    await settings.update.square.sandbox(true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("lists locations through the sandbox API", async () => {
    mockFetch = installMockFetch(() =>
      Promise.resolve(
        jsonResponse({
          locations: [
            { id: "L_1", name: "Main", status: "ACTIVE" },
            { id: "L_2", name: "Branch", status: "INACTIVE" },
          ],
        }),
      ),
    );
    const client = await squareApi.getSquareClient();
    const result = await client!.locations.list();
    expect(mockFetch.calls[0]?.args[0]).toBe(
      "https://connect.squareupsandbox.com/v2/locations",
    );
    expect(mockFetch.calls[0]?.args[1].method).toBe("GET");
    expect(result.locations).toEqual([
      { id: "L_1", name: "Main", status: "ACTIVE" },
      { id: "L_2", name: "Branch", status: "INACTIVE" },
    ]);
  });

  test("uses the production API when sandbox mode is disabled", async () => {
    squareApi.resetSquareClient();
    await settings.update.square.sandbox(false);
    mockFetch = installMockFetch(() =>
      Promise.resolve(
        jsonResponse({
          order: {
            created_at: "2026-07-26T12:00:00.000Z",
            id: "test",
            location_id: "L_rest",
            state: "OPEN",
            total_money: { amount: 1, currency: "USD" },
          },
        }),
      ),
    );
    const client = await squareApi.getSquareClient();
    await client!.orders.get({ orderId: "test" });
    expect(mockFetch.calls[0]?.args[0]).toContain("connect.squareup.com");
  });
});
