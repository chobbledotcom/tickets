import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attemptLedgerPost } from "#shared/ledger/safe-post.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

describe("ledger > safe post", () => {
  const errors = setupErrorSpy();

  test("returns the result of a successful post", async () => {
    expect(
      await attemptLedgerPost(
        "test ledger post",
        12,
      )(() => Promise.resolve(true)),
    ).toEqual({ posted: true });
    expect(errors.calls).toHaveLength(0);
  });

  test("reports a failed post without throwing", async () => {
    expect(
      await attemptLedgerPost(
        "test ledger post",
        12,
      )(() => Promise.reject(new Error("write failed"))),
    ).toEqual({ posted: false });
    expect(errors.lastMessage()).toContain("E_LEDGER_POST");
    expect(errors.lastMessage()).toContain(
      "test ledger post failed for attendee 12: Error: write failed",
    );
  });
});
