import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  refundCallbackReplayIndex,
  refundRequestIdentityIndex,
} from "#shared/payment/refund-request-identity.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";

const reference = (
  provider: TaggedPaymentReference["provider"],
): TaggedPaymentReference => ({
  kind: "tagged",
  provider,
  reference: "same-charge",
});

describe("refund request identity", () => {
  beforeAll(setupTestEncryptionKey);

  test("is stable only for the same provider charge and generation", async () => {
    const first = await refundRequestIdentityIndex(reference("stripe"), 2);
    expect(await refundRequestIdentityIndex(reference("stripe"), 2)).toBe(
      first,
    );
    expect(await refundRequestIdentityIndex(reference("square"), 2)).not.toBe(
      first,
    );
    expect(await refundRequestIdentityIndex(reference("stripe"), 3)).not.toBe(
      first,
    );
  });

  test("refuses an invalid generation before hashing", () => {
    expect(() => refundRequestIdentityIndex(reference("stripe"), 0)).toThrow(
      "Refund generation must be a positive safe integer",
    );
  });

  test("keeps callback replay identity stable and provider-qualified", async () => {
    const stripe = await refundCallbackReplayIndex("stripe", "session-one");
    expect(await refundCallbackReplayIndex("stripe", "session-one")).toBe(
      stripe,
    );
    expect(await refundCallbackReplayIndex("square", "session-one")).not.toBe(
      stripe,
    );
  });

  test("refuses a blank callback session identity", () => {
    expect(() => refundCallbackReplayIndex("sumup", "  ")).toThrow(
      "Refund callback session id must not be blank",
    );
  });
});
