import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  readProviderRefundCursor,
  writeProviderRefundCursor,
} from "#shared/provider-refund-cursor.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";

describe("provider refund queue cursor", () => {
  beforeAll(setupTestEncryptionKey);

  test("round-trips one opaque positive boundary", async () => {
    const cursor = await writeProviderRefundCursor(42);
    expect(cursor).not.toContain("refund-cases");
    expect(await readProviderRefundCursor(cursor)).toBe(42);
  });

  test("refuses changed, non-canonical, and malformed input", async () => {
    const cursor = await writeProviderRefundCursor(42);
    expect(await readProviderRefundCursor(cursor.replace(/^42/u, "41")))
      .toBeNull();
    expect(await readProviderRefundCursor(`042.${cursor.split(".")[1]}`))
      .toBeNull();
    expect(await readProviderRefundCursor("42")).toBeNull();
  });

  test("refuses an invalid boundary before signing", async () => {
    await expect(writeProviderRefundCursor(0)).rejects.toThrow(
      "Refund-case cursor id must be a positive safe integer",
    );
  });
});
