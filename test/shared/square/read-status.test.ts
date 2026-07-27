import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { squareApi } from "#shared/square.ts";
import { describeSquare } from "#test/lib/square/harness.ts";
import { installMockFetch } from "#test/lib/square/mock-fetch.ts";

describeSquare(() => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await settings.update.square.accessToken("EAAAl_read_status");
    await settings.update.square.sandbox(true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns missing for a Square 404", async () => {
    installMockFetch(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("missing"),
      }),
    );
    expect(await squareApi.readPayment("payment-missing")).toEqual({
      status: "missing",
    });
  });

  test("returns unavailable for a transient Square failure", async () => {
    installMockFetch(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        text: () => Promise.resolve("down"),
      }),
    );
    expect(await squareApi.readPayment("payment-later")).toEqual({
      status: "unavailable",
    });
  });
});
