import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import {
  getSquareClient,
  resetSquareClient,
  testSquareConnection,
} from "#shared/square.ts";
import { createTestDb, resetDb } from "#test-utils";
import { setupFetchStub } from "#test-utils/fetch-stub.ts";
import { configureSquare, oneLocation, withSquareClient } from "./fixtures.ts";
import { describeSquare } from "./harness.ts";

describeSquare(() => {
  describe("getSquareClient", () => {
    const { stubFetch } = setupFetchStub();
    let calledUrl = "";

    /** Install one fetch stub for this test that records the URL it was given. */
    const trackFetch = () =>
      stubFetch((url) => {
        calledUrl = String(url);
        return Promise.resolve(new Response(JSON.stringify({ locations: [] })));
      });

    /** Drive one request through the client and return the host it called. */
    const hostFor = async (
      client: NonNullable<Awaited<ReturnType<typeof getSquareClient>>>,
    ): Promise<string> => {
      await client.locations.list();
      return new URL(calledUrl).host;
    };

    test("returns null when access token not set", async () => {
      const client = await getSquareClient();
      expect(client).toBeNull();
    });

    test("returns client when access token is set in database", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      const client = await getSquareClient();
      expect(client).not.toBeNull();
    });

    test("returns cached client on second call with same token", async () => {
      await settings.update.square.accessToken("EAAAl_cache_test");
      const client1 = await getSquareClient();
      expect(client1).not.toBeNull();

      // Second call with same token returns the very same cached instance.
      const client2 = await getSquareClient();
      expect(client2).toBe(client1);
    });

    test("returns client in sandbox mode when sandbox setting enabled", async () => {
      await settings.update.square.accessToken("EAAAl_sandbox_123");
      await settings.update.square.sandbox(true);
      const client = await getSquareClient();
      expect(client).not.toBeNull();
      // Sandbox mode must route requests to the sandbox host.
      trackFetch();
      expect(await hostFor(client!)).toBe("connect.squareupsandbox.com");
    });

    test("recreates client when sandbox setting changes", async () => {
      await settings.update.square.accessToken("EAAAl_sandbox_toggle");
      await settings.update.square.sandbox(false);
      const client1 = await getSquareClient();
      expect(client1).not.toBeNull();
      trackFetch();
      expect(await hostFor(client1!)).toBe("connect.squareup.com");

      // Toggling sandbox creates a new client configured for the sandbox host.
      await settings.update.square.sandbox(true);
      const client2 = await getSquareClient();
      expect(client2).not.toBe(client1);
      expect(await hostFor(client2!)).toBe("connect.squareupsandbox.com");
    });
  });

  describe("resetSquareClient", () => {
    test("resets client state after token removed from db", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      const client1 = await getSquareClient();
      expect(client1).not.toBeNull();

      resetSquareClient();
      resetDb();
      await createTestDb();

      const client2 = await getSquareClient();
      expect(client2).toBeNull();
    });
  });

  describe("testSquareConnection", () => {
    type ConnectionResult = Awaited<ReturnType<typeof testSquareConnection>>;

    /** Checks only the parts of a connection result a test names. */
    const expectConnection = (
      result: ConnectionResult,
      want: {
        ok?: boolean;
        tokenValid?: boolean;
        tokenError?: string;
        mode?: string;
        locationConfigured?: boolean;
        locationName?: string;
        locationStatus?: string;
        locationError?: string;
        webhookConfigured?: boolean;
        webhookError?: string;
      },
    ) => {
      if (want.ok !== undefined) expect(result.ok).toBe(want.ok);
      if (want.tokenValid !== undefined) {
        expect(result.accessToken.valid).toBe(want.tokenValid);
      }
      if (want.tokenError !== undefined) {
        expect(result.accessToken.error).toContain(want.tokenError);
      }
      if (want.mode !== undefined) {
        expect(result.accessToken.mode).toBe(want.mode);
      }
      if (want.locationConfigured !== undefined) {
        expect(result.location.configured).toBe(want.locationConfigured);
      }
      if (want.locationName !== undefined) {
        expect(result.location.name).toBe(want.locationName);
      }
      if (want.locationStatus !== undefined) {
        expect(result.location.status).toBe(want.locationStatus);
      }
      if (want.locationError !== undefined) {
        expect(result.location.error).toContain(want.locationError);
      }
      if (want.webhookConfigured !== undefined) {
        expect(result.webhook.configured).toBe(want.webhookConfigured);
      }
      if (want.webhookError !== undefined) {
        expect(result.webhook.error).toContain(want.webhookError);
      }
    };

    /** Store settings, stub locations.list, run the checks, assert the result. */
    const runConnection = async (
      config: Parameters<typeof configureSquare>[0],
      locationsList: () => Promise<unknown>,
      assert: (result: ConnectionResult) => void,
    ) => {
      await configureSquare(config);
      await withSquareClient({ locationsList }, async () => {
        assert(await testSquareConnection());
      });
    };

    test("returns error when no access token configured", async () => {
      expectConnection(await testSquareConnection(), {
        ok: false,
        tokenError: "No Square access token configured",
        tokenValid: false,
      });
    });

    test("returns error when locations list fails", async () => {
      await runConnection(
        {},
        () => Promise.reject(new Error("Invalid access token")),
        (result) =>
          expectConnection(result, {
            ok: false,
            tokenError: "Invalid access token",
            tokenValid: false,
          }),
      );
    });

    test("returns sandbox mode with valid token and all checks pass", async () => {
      await runConnection(
        {
          locationId: "L_test_123",
          sandbox: true,
          webhookSignatureKey: "sig_key_test",
        },
        () => Promise.resolve(oneLocation("L_test_123", "Test Store")),
        (result) =>
          expectConnection(result, {
            locationConfigured: true,
            locationName: "Test Store",
            locationStatus: "ACTIVE",
            mode: "sandbox",
            ok: true,
            tokenValid: true,
            webhookConfigured: true,
          }),
      );
    });

    test("returns production mode when sandbox disabled", async () => {
      await runConnection(
        {
          accessToken: "EAAAl_live_123",
          locationId: "L_live_123",
          sandbox: false,
          webhookSignatureKey: "sig_key_live",
        },
        () => Promise.resolve(oneLocation("L_live_123", "Live Store")),
        (result) =>
          expectConnection(result, {
            mode: "production",
            ok: true,
            tokenValid: true,
          }),
      );
    });

    test("returns location error when location ID not found", async () => {
      await runConnection(
        { locationId: "L_wrong", webhookSignatureKey: "sig_key_test" },
        () => Promise.resolve(oneLocation("L_test_123", "Test Store")),
        (result) =>
          expectConnection(result, {
            locationConfigured: false,
            locationError: "Location ID not found in account",
            ok: false,
            tokenValid: true,
          }),
      );
    });

    test("returns location error when no location ID configured", async () => {
      await runConnection(
        { webhookSignatureKey: "sig_key_test" },
        () => Promise.resolve({ locations: [{ id: "L_test_123" }] }),
        (result) =>
          expectConnection(result, {
            locationConfigured: false,
            locationError: "No location ID configured",
            ok: false,
          }),
      );
    });

    test("handles empty locations response", async () => {
      await runConnection(
        {
          locationId: "L_test_123",
          sandbox: true,
          webhookSignatureKey: "sig_key_test",
        },
        () => Promise.resolve({}),
        (result) =>
          expectConnection(result, {
            locationConfigured: false,
            locationError: "Location ID not found in account",
            tokenValid: true,
          }),
      );
    });

    test("returns webhook error when no signature key configured", async () => {
      await runConnection(
        { locationId: "L_test_123" },
        () => Promise.resolve(oneLocation("L_test_123", "Test Store")),
        (result) =>
          expectConnection(result, {
            locationConfigured: true,
            ok: false,
            tokenValid: true,
            webhookConfigured: false,
            webhookError: "No webhook signature key configured",
          }),
      );
    });
  });
});
