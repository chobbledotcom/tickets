import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { databaseHostFor } from "#shared/db/host.ts";

describe("database host", () => {
  const cases: [string, string][] = [
    ["libsql://01abc-tickets-spencer.lite.bunnydb.net/", "bunny"],
    ["https://01abc-tickets.lite.bunnydb.net", "bunny"],
    ["libsql://tickets-chobble.turso.io", "turso"],
    ["libsql://db.example.com", "other"],
    ["https://db.example.com", "other"],
    ["file:local.db", "local"],
    ["local.db", "local"],
    ["", "local"],
  ];

  for (const [url, expected] of cases) {
    test(`reads ${url || "(blank)"} as ${expected}`, () => {
      expect(databaseHostFor(url)).toBe(expected);
    });
  }

  test("does not treat a lookalike hostname as a hosted database", () => {
    expect(databaseHostFor("libsql://bunnydb.net.example.com")).toBe("other");
    expect(databaseHostFor("libsql://turso.io.example.com")).toBe("other");
  });
});
