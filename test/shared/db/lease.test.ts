import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { claimDatabaseRow } from "#shared/db/lease.ts";

describe("db > lease", () => {
  test("builds a domain claim from the claimed row and lease", async () => {
    const claim = await claimDatabaseRow(250)(
      (lease) => Promise.resolve({ duration: lease.duration, value: "4" }),
      (raw) => ({ ...raw, value: Number(raw.value) }),
      (row, leaseToken) => ({
        duration: row.duration,
        leaseToken,
        value: row.value * 2,
      }),
    );

    expect(claim?.duration).toBe(250);
    expect(claim?.value).toBe(8);
    expect(claim?.leaseToken.length).toBeGreaterThan(20);
  });

  test("does not read or map a missing claimed row", async () => {
    expect(
      await claimDatabaseRow(250)(
        () => Promise.resolve(null),
        () => {
          throw new Error("must not read");
        },
        () => {
          throw new Error("must not map");
        },
      ),
    ).toBeNull();
  });

  test("rejects a lease that cannot own a row", async () => {
    await expect(
      claimDatabaseRow(0)(
        () => Promise.resolve(null),
        (raw) => raw,
        (row) => row,
      ),
    ).rejects.toThrow();
  });
});
