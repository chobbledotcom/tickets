import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { squareApi } from "#shared/square/api.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { debugMessages, useDebugLogSpy } from "#test-utils/debug-log.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { describeSquare } from "#test-utils/square/harness.ts";

describeSquare(() => {
  describe("getSquareClient", () => {
    const debugLog = useDebugLogSpy();
    let calledUrl = "";

    /** Install one fetch stub for this test that records the URL it was given. */
    const trackFetch = (): Disposable =>
      stubFetch((url) => {
        calledUrl = String(url);
        return Promise.resolve(new Response(JSON.stringify({ locations: [] })));
      });

    /** Drive one request through the client and return the host it called. */
    const hostFor = async (
      client: NonNullable<
        Awaited<ReturnType<typeof squareApi.getSquareClient>>
      >,
    ): Promise<string> => {
      await client.locations.list();
      return new URL(calledUrl).host;
    };

    test("returns null when access token not set", async () => {
      const client = await squareApi.getSquareClient();
      expect(client).toBeNull();
      expect(debugMessages(debugLog())).toEqual([
        "[Square] No access token configured, cannot create client",
      ]);
    });

    test("returns client when access token is set in database", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      const client = await squareApi.getSquareClient();
      expect(client).not.toBeNull();
      expect(debugLog().calls.at(-1)?.args[0]).toBe(
        "[Square] Creating new Square client (production)",
      );
    });

    test("returns cached client on second call with same token", async () => {
      await settings.update.square.accessToken("EAAAl_cache_test");
      const client1 = await squareApi.getSquareClient();
      expect(client1).not.toBeNull();

      // Second call with same token returns the very same cached instance.
      const client2 = await squareApi.getSquareClient();
      expect(client2).toBe(client1);
    });

    test("returns client in sandbox mode when sandbox setting enabled", async () => {
      await settings.update.square.accessToken("EAAAl_sandbox_123");
      await settings.update.square.sandbox(true);
      const client = await squareApi.getSquareClient();
      expect(client).not.toBeNull();
      // Sandbox mode must route requests to the sandbox host.
      using _fetch = trackFetch();
      expect(await hostFor(client!)).toBe("connect.squareupsandbox.com");
      expect(debugLog().calls.at(-1)?.args[0]).toBe(
        "[Square] Creating new Square client (sandbox)",
      );
    });

    test("recreates client when sandbox setting changes", async () => {
      await settings.update.square.accessToken("EAAAl_sandbox_toggle");
      await settings.update.square.sandbox(false);
      const client1 = await squareApi.getSquareClient();
      expect(client1).not.toBeNull();
      using _fetch = trackFetch();
      expect(await hostFor(client1!)).toBe("connect.squareup.com");

      // Toggling sandbox creates a new client configured for the sandbox host.
      await settings.update.square.sandbox(true);
      const client2 = await squareApi.getSquareClient();
      expect(client2).not.toBe(client1);
      expect(await hostFor(client2!)).toBe("connect.squareupsandbox.com");
    });
  });

  describe("resetSquareClient", () => {
    test("resets client state after token removed from db", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      const client1 = await squareApi.getSquareClient();
      expect(client1).not.toBeNull();

      squareApi.resetSquareClient();
      resetDb();
      await createTestDb();

      const client2 = await squareApi.getSquareClient();
      expect(client2).toBeNull();
    });
  });
});
