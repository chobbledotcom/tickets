import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { UptimeKumaError } from "#shared/uptime-kuma/error.ts";

describe("Uptime Kuma errors", () => {
  test("carry a machine-readable kind instead of user copy", () => {
    expect(new UptimeKumaError("connection_failed")).toMatchObject({
      kind: "connection_failed",
      message: "connection_failed",
    });
  });
});
