import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { createWalletSettingsKit } from "#shared/wallets/wallet-settings-types.ts";
import { withEnv } from "#test-utils/env.ts";

type Pass = { issuer: string; team: string };

/** A two-field wallet whose config exists only when both fields are filled. */
const kit = createWalletSettingsKit<Pass, "issuer" | "team">({
  build: (vals) =>
    vals.issuer && vals.team ? { issuer: vals.issuer, team: vals.team } : null,
  fields: {
    issuer: { dbKey: "test_wallet_issuer", envKey: "TEST_WALLET_ISSUER" },
    team: { dbKey: "test_wallet_team", envKey: "TEST_WALLET_TEAM" },
  },
});

/** A snapshot reader over a plain record of stored values. */
const storing = (stored: Record<string, string>) => (key: string) =>
  stored[key] ?? "";

describe("createWalletSettingsKit", () => {
  afterEach(() => {
    kit.createReadSettings(storing({})).resetHostConfig();
  });

  describe("reading the database", () => {
    test("gives each field its stored value", () => {
      const read = kit.createReadSettings(
        storing({ test_wallet_issuer: "abc", test_wallet_team: "xyz" }),
      );
      expect(read.issuer).toBe("abc");
      expect(read.team).toBe("xyz");
    });

    test("builds the config when every field is filled", () => {
      const read = kit.createReadSettings(
        storing({ test_wallet_issuer: "abc", test_wallet_team: "xyz" }),
      );
      expect(read.hasDbConfig).toBe(true);
      expect(read.dbConfig).toEqual({ issuer: "abc", team: "xyz" });
    });

    test("builds no config while a field is still blank", () => {
      const read = kit.createReadSettings(storing({ test_wallet_issuer: "a" }));
      expect(read.hasDbConfig).toBe(false);
      expect(read.dbConfig).toBeNull();
    });
  });

  describe("falling back to the host", () => {
    test("reads the host's environment when the database has nothing", () => {
      using _env = withEnv({
        TEST_WALLET_ISSUER: "host-issuer",
        TEST_WALLET_TEAM: "host-team",
      });
      const read = kit.createReadSettings(storing({}));
      expect(read.hostConfig).toEqual({
        issuer: "host-issuer",
        team: "host-team",
      });
      expect(read.config).toEqual(read.hostConfig);
      expect(read.hasConfig).toBe(true);
    });

    test("prefers the database over the host", () => {
      using _env = withEnv({
        TEST_WALLET_ISSUER: "host-issuer",
        TEST_WALLET_TEAM: "host-team",
      });
      const read = kit.createReadSettings(
        storing({ test_wallet_issuer: "db", test_wallet_team: "db-team" }),
      );
      expect(read.config).toEqual({ issuer: "db", team: "db-team" });
    });

    test("has no config at all when neither side is set up", () => {
      const read = kit.createReadSettings(storing({}));
      expect(read.config).toBeNull();
      expect(read.hasConfig).toBe(false);
    });
  });

  describe("the host override a test stands in front", () => {
    test("is read instead of the environment", () => {
      const read = kit.createReadSettings(storing({}));
      read.setHostConfigForTest({ issuer: "stood-in", team: "here" });
      expect(read.hostConfig).toEqual({ issuer: "stood-in", team: "here" });
    });

    test("goes away when it is reset", () => {
      const read = kit.createReadSettings(storing({}));
      read.setHostConfigForTest({ issuer: "stood-in", team: "here" });
      read.resetHostConfig();
      expect(read.hostConfig).toBeNull();
    });
  });
});
