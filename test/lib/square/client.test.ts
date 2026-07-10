import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import {
  getSquareClient,
  resetSquareClient,
  squareApi,
  testSquareConnection,
} from "#shared/square.ts";
import { createTestDb, resetDb, withMocks } from "#test-utils";
import { createMockClient, describeSquare } from "./harness.ts";

describeSquare(() => {
  describe("getSquareClient", () => {
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

      // Second call with same token should use cached path
      const client2 = await getSquareClient();
      expect(client2).not.toBeNull();
    });

    test("returns client in sandbox mode when sandbox setting enabled", async () => {
      await settings.update.square.accessToken("EAAAl_sandbox_123");
      await settings.update.square.sandbox(true);
      const client = await getSquareClient();
      expect(client).not.toBeNull();
    });

    test("recreates client when sandbox setting changes", async () => {
      await settings.update.square.accessToken("EAAAl_sandbox_toggle");
      await settings.update.square.sandbox(false);
      const client1 = await getSquareClient();
      expect(client1).not.toBeNull();

      // Toggle sandbox mode - should create new client
      await settings.update.square.sandbox(true);
      const client2 = await getSquareClient();
      expect(client2).not.toBeNull();
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
    test("returns error when no access token configured", async () => {
      const result = await testSquareConnection();
      expect(result.ok).toBe(false);
      expect(result.accessToken.valid).toBe(false);
      expect(result.accessToken.error).toContain(
        "No Square access token configured",
      );
    });

    test("returns error when locations list fails", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      const mock = createMockClient({
        locationsList: () => Promise.reject(new Error("Invalid access token")),
      });

      await withMocks(
        () =>
          stub(squareApi, "getSquareClient", () =>
            Promise.resolve(mock.client),
          ),
        async () => {
          const result = await testSquareConnection();
          expect(result.ok).toBe(false);
          expect(result.accessToken.valid).toBe(false);
          expect(result.accessToken.error).toContain("Invalid access token");
        },
      );
    });

    test("returns sandbox mode with valid token and all checks pass", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.sandbox(true);
      await settings.update.square.locationId("L_test_123");
      await settings.update.square.webhookSignatureKey("sig_key_test");
      const mock = createMockClient({
        locationsList: () =>
          Promise.resolve({
            locations: [
              { id: "L_test_123", name: "Test Store", status: "ACTIVE" },
            ],
          }),
      });

      await withMocks(
        () =>
          stub(squareApi, "getSquareClient", () =>
            Promise.resolve(mock.client),
          ),
        async () => {
          const result = await testSquareConnection();
          expect(result.ok).toBe(true);
          expect(result.accessToken.valid).toBe(true);
          expect(result.accessToken.mode).toBe("sandbox");
          expect(result.location.configured).toBe(true);
          expect(result.location.name).toBe("Test Store");
          expect(result.location.status).toBe("ACTIVE");
          expect(result.webhook.configured).toBe(true);
        },
      );
    });

    test("returns production mode when sandbox disabled", async () => {
      await settings.update.square.accessToken("EAAAl_live_123");
      await settings.update.square.sandbox(false);
      await settings.update.square.locationId("L_live_123");
      await settings.update.square.webhookSignatureKey("sig_key_live");
      const mock = createMockClient({
        locationsList: () =>
          Promise.resolve({
            locations: [
              { id: "L_live_123", name: "Live Store", status: "ACTIVE" },
            ],
          }),
      });

      await withMocks(
        () =>
          stub(squareApi, "getSquareClient", () =>
            Promise.resolve(mock.client),
          ),
        async () => {
          const result = await testSquareConnection();
          expect(result.ok).toBe(true);
          expect(result.accessToken.valid).toBe(true);
          expect(result.accessToken.mode).toBe("production");
        },
      );
    });

    test("returns location error when location ID not found", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.locationId("L_wrong");
      await settings.update.square.webhookSignatureKey("sig_key_test");
      const mock = createMockClient({
        locationsList: () =>
          Promise.resolve({
            locations: [
              { id: "L_test_123", name: "Test Store", status: "ACTIVE" },
            ],
          }),
      });

      await withMocks(
        () =>
          stub(squareApi, "getSquareClient", () =>
            Promise.resolve(mock.client),
          ),
        async () => {
          const result = await testSquareConnection();
          expect(result.ok).toBe(false);
          expect(result.accessToken.valid).toBe(true);
          expect(result.location.configured).toBe(false);
          expect(result.location.error).toContain(
            "Location ID not found in account",
          );
        },
      );
    });

    test("returns location error when no location ID configured", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.webhookSignatureKey("sig_key_test");
      const mock = createMockClient({
        locationsList: () =>
          Promise.resolve({ locations: [{ id: "L_test_123" }] }),
      });

      await withMocks(
        () =>
          stub(squareApi, "getSquareClient", () =>
            Promise.resolve(mock.client),
          ),
        async () => {
          const result = await testSquareConnection();
          expect(result.ok).toBe(false);
          expect(result.location.configured).toBe(false);
          expect(result.location.error).toContain("No location ID configured");
        },
      );
    });

    test("handles empty locations response", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.sandbox(true);
      await settings.update.square.locationId("L_test_123");
      await settings.update.square.webhookSignatureKey("sig_key_test");
      const mock = createMockClient({
        locationsList: () => Promise.resolve({}),
      });

      await withMocks(
        () =>
          stub(squareApi, "getSquareClient", () =>
            Promise.resolve(mock.client),
          ),
        async () => {
          const result = await testSquareConnection();
          expect(result.accessToken.valid).toBe(true);
          expect(result.location.configured).toBe(false);
          expect(result.location.error).toContain(
            "Location ID not found in account",
          );
        },
      );
    });

    test("returns webhook error when no signature key configured", async () => {
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.locationId("L_test_123");
      const mock = createMockClient({
        locationsList: () =>
          Promise.resolve({
            locations: [
              { id: "L_test_123", name: "Test Store", status: "ACTIVE" },
            ],
          }),
      });

      await withMocks(
        () =>
          stub(squareApi, "getSquareClient", () =>
            Promise.resolve(mock.client),
          ),
        async () => {
          const result = await testSquareConnection();
          expect(result.ok).toBe(false);
          expect(result.accessToken.valid).toBe(true);
          expect(result.location.configured).toBe(true);
          expect(result.webhook.configured).toBe(false);
          expect(result.webhook.error).toContain(
            "No webhook signature key configured",
          );
        },
      );
    });
  });
});
