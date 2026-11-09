/** Direct tests for the listed-database lookup in host.ts: the host an address
 *  reaches, and the provider's database behind it. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { addressHost, requireListedDatabase } from "#db/host.ts";
import { errorResult, okResult } from "#shared/result.ts";

describe("the database at an address", () => {
  test("reads the host an address reaches", () => {
    expect(
      ["libsql://first.turso.io", "https://FIRST.turso.io/path"].map(
        addressHost,
      ),
    ).toEqual(["first.turso.io", "first.turso.io"]);
    expect(() => addressHost("not a url")).toThrow(TypeError);
  });

  test("answers the listed database an address reaches, or the refusal", () => {
    const second = { host: "second.lite.bunnydb.net", id: "second" };
    const find = (url: string, provider: string) =>
      requireListedDatabase(
        okResult([{ host: "first.turso.io", id: "first" }, second]),
        url,
        provider,
      );

    expect([
      find("libsql://second.lite.bunnydb.net", "Bunny"),
      find("libsql://gone.turso.io", "Turso"),
      requireListedDatabase(errorResult("refused"), "libsql://a.io", "Turso"),
    ]).toEqual([
      okResult(second),
      errorResult("No Turso database has the address gone.turso.io."),
      errorResult("refused"),
    ]);
  });
});
