import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { squareApi } from "#shared/square/api.ts";
import {
  configureSquare,
  oneLocation,
  withSquareClient,
} from "#test-utils/square/fixtures.ts";
import { describeSquare } from "#test-utils/square/harness.ts";

describeSquare(() => {
  describe("testSquareConnection", () => {
    type ConnectionResult = Awaited<
      ReturnType<typeof squareApi.testSquareConnection>
    >;

    /** Run an assertion only when the test named a value for it. */
    const when = <T>(value: T | undefined, assert: (value: T) => void) => {
      if (value !== undefined) assert(value);
    };

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
      when(want.ok, (ok) => expect(result.ok).toBe(ok));
      when(want.tokenValid, (v) => expect(result.accessToken.valid).toBe(v));
      when(want.tokenError, (e) =>
        expect(result.accessToken.error).toContain(e),
      );
      when(want.mode, (mode) => expect(result.accessToken.mode).toBe(mode));
      when(want.locationConfigured, (c) =>
        expect(result.location.configured).toBe(c),
      );
      when(want.locationName, (n) => expect(result.location.name).toBe(n));
      when(want.locationStatus, (s) => expect(result.location.status).toBe(s));
      when(want.locationError, (e) => expect(result.location.error).toBe(e));
      when(want.webhookConfigured, (c) =>
        expect(result.webhook.configured).toBe(c),
      );
      when(want.webhookError, (e) => expect(result.webhook.error).toContain(e));
    };

    /** Store settings, stub locations.list, run the checks, assert the result. */
    const runConnection = async (
      config: Parameters<typeof configureSquare>[0],
      locationsList: () => Promise<unknown>,
      assert: (result: ConnectionResult) => void,
    ) => {
      await configureSquare(config);
      await withSquareClient({ locationsList }, async () => {
        assert(await squareApi.testSquareConnection());
      });
    };

    test("returns error when no access token configured", async () => {
      expect(await squareApi.testSquareConnection()).toEqual({
        accessToken: {
          error: "No Square access token configured",
          valid: false,
        },
        location: { configured: false },
        ok: false,
        webhook: { configured: false },
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
        () => Promise.resolve({ locations: [] }),
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
          expect(result).toEqual({
            accessToken: { mode: "production", valid: true },
            location: {
              configured: true,
              locationId: "L_test_123",
              name: "Test Store",
              status: "ACTIVE",
            },
            ok: false,
            webhook: {
              configured: false,
              error: "No webhook signature key configured",
            },
          }),
      );
    });
  });
});
