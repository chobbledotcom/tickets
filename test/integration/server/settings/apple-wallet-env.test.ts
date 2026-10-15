import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { configureAppleWallet } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { says } from "#test-utils/says.ts";
import { adminGet } from "#test-utils/session.ts";
import {
  fetchValidPkpassForNewAttendee,
  fetchWalletTicketBody,
  parsePkpassJson,
  setWalletEnvVars,
} from "./apple-wallet-helpers.ts";

describeWithEnv(
  "Apple Wallet env var fallback",
  {
    db: true,
    env: {
      APPLE_WALLET_PASS_TYPE_ID: undefined,
      APPLE_WALLET_SIGNING_CERT: undefined,
      APPLE_WALLET_SIGNING_KEY: undefined,
      APPLE_WALLET_TEAM_ID: undefined,
      APPLE_WALLET_WWDR_CERT: undefined,
    },
  },
  () => {
    test("hasAppleWalletConfig returns true with env vars when DB not configured", () => {
      using _env = setWalletEnvVars();
      expect(settings.appleWallet.hasDbConfig).toBe(false);
      expect(settings.appleWallet.hasConfig).toBe(true);
    });

    test("getAppleWalletConfig falls back to env vars when DB not configured", () => {
      using _env = setWalletEnvVars();
      const config = settings.appleWallet.config;
      expect(config).not.toBeNull();
      expect(config!.passTypeId).toBe("pass.com.env.tickets");
      expect(config!.teamId).toBe("ENVTEAM001");
    });

    test("getAppleWalletConfig prefers DB config over env vars", async () => {
      using _env = setWalletEnvVars();
      await configureAppleWallet();
      const config = settings.appleWallet.config;
      expect(config).not.toBeNull();
      expect(config!.passTypeId).toBe("pass.com.test.tickets");
      expect(config!.teamId).toBe("TESTTEAM01");
    });

    test("wallet route works with env var config", async () => {
      using _env = setWalletEnvVars();
      const { token } = await fetchValidPkpassForNewAttendee();

      const passJson = await parsePkpassJson(token);
      expect(passJson.passTypeIdentifier).toBe("pass.com.env.tickets");
      expect(passJson.teamIdentifier).toBe("ENVTEAM001");
    });

    test("ticket view shows wallet link with env var config", async () => {
      using _env = setWalletEnvVars();
      const { token } = await createTestAttendeeWithToken(
        "Alice",
        "alice@test.com",
      );
      const body = await fetchWalletTicketBody(token);
      says(body, "wallet-link");
      says(body, "Apple Wallet");
    });

    test("settings page shows host Apple Wallet label when env vars configured", async () => {
      using _env = setWalletEnvVars();
      const response = await adminGet("/admin/settings-advanced");
      const body = await response.text();
      says(body, "Host env (pass.com.env.tickets)");
      says(body, "Currently using");
    });

    test("settings page shows overriding label when both DB and env configured", async () => {
      using _env = setWalletEnvVars();
      await configureAppleWallet();
      const response = await adminGet("/admin/settings-advanced");
      const body = await response.text();
      says(body, "Host env (pass.com.env.tickets)");
      says(body, "Overriding");
    });
  },
);
