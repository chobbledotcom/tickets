import { type Client, createClient } from "@libsql/client";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import {
  hasSiteDbCredentials,
  readSiteSetting,
  siteDbApi,
  withSiteDb,
} from "#shared/site-db.ts";

/** Build an in-memory libsql client seeded with a settings table. */
const seededClient = async (rows: [string, string][]): Promise<Client> => {
  const client = createClient({ url: ":memory:" });
  await client.execute(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)",
  );
  for (const [key, value] of rows) {
    await client.execute({
      args: [key, value],
      sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
    });
  }
  return client;
};

describe("hasSiteDbCredentials", () => {
  test("true only when both URL and token are present", () => {
    expect(hasSiteDbCredentials({ dbToken: "t", dbUrl: "libsql://u" })).toBe(
      true,
    );
    expect(hasSiteDbCredentials({ dbToken: "", dbUrl: "libsql://u" })).toBe(
      false,
    );
    expect(hasSiteDbCredentials({ dbToken: "t", dbUrl: "" })).toBe(false);
  });
});

describe("withSiteDb", () => {
  test("returns an error without ever connecting when URL is empty", async () => {
    const createStub = stub(siteDbApi, "createClient");
    try {
      const result = await withSiteDb({ dbToken: "t", dbUrl: "" }, () =>
        Promise.resolve("unused"),
      );
      expect(result).toEqual({
        error: "No database URL for this site",
        ok: false,
      });
      expect(createStub.calls.length).toBe(0);
    } finally {
      createStub.restore();
    }
  });

  test("returns an error when opening the connection throws", async () => {
    const createStub = stub(siteDbApi, "createClient", () => {
      throw new Error("connect boom");
    });
    try {
      const result = await withSiteDb(
        { dbToken: "t", dbUrl: "libsql://x" },
        () => Promise.resolve("unused"),
      );
      expect(result).toEqual({ error: "connect boom", ok: false });
    } finally {
      createStub.restore();
    }
  });
});

describe("readSiteSetting", () => {
  let client: Client;
  let createStub: Stub;

  beforeEach(async () => {
    client = await seededClient([
      ["current_script_version", "2026-06-19T12:00:00Z"],
    ]);
    createStub = stub(siteDbApi, "createClient", () => client);
  });

  afterEach(() => {
    createStub.restore();
    client.close();
  });

  test("returns the stored value for a present key", async () => {
    const result = await readSiteSetting(
      { dbToken: "t", dbUrl: "libsql://u" },
      "current_script_version",
    );
    expect(result).toEqual({ ok: true, value: "2026-06-19T12:00:00Z" });
  });

  test("connects with the site's read-only URL and token", async () => {
    await readSiteSetting(
      { dbToken: "ro-token", dbUrl: "libsql://site.example" },
      "current_script_version",
    );
    expect(createStub.calls[0]!.args).toEqual([
      "libsql://site.example",
      "ro-token",
    ]);
  });

  test("returns null for a missing key", async () => {
    const result = await readSiteSetting(
      { dbToken: "t", dbUrl: "libsql://u" },
      "does_not_exist",
    );
    expect(result).toEqual({ ok: true, value: null });
  });
});
