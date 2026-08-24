import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { judgedBy } from "#payment/provider-resource-read.ts";
import { providerDetail, transportError } from "#payment/transport-error.ts";
import {
  namedSquareRefund,
  readSquareResource,
  squareRefundFailure,
} from "#shared/square/outcomes.ts";

/** Ask a Square resource for something the call is going to fail at. */
const readThrowing = (error: unknown) =>
  readSquareResource(() => Promise.resolve({}))(
    () => Promise.reject(error),
    judgedBy([]),
  );

describe("Square failure and proof readings", () => {
  describe("namedSquareRefund", () => {
    test("names the refund and the charge it came back from", () => {
      expect(namedSquareRefund({ id: "ref_1", paymentId: "pay_1" })).toEqual({
        kind: "named_refund",
        refund: {
          id: "ref_1",
          kind: "square_refund",
          parentId: "pay_1",
          provider: "square",
        },
      });
    });
  });

  for (const [name, read, refund] of [
    [
      "an answer we cannot read",
      { reason: "malformed_response", status: "invalid" },
      { kind: "uncertain", reason: "malformed_response" },
    ],
    [
      "a provider we never reached",
      { reason: "network_error", status: "unavailable" },
      { kind: "uncertain", reason: "network_error" },
    ],
  ] as const) {
    test(`reads ${name} the same way for reads and refunds`, async () => {
      const error =
        read.reason === "malformed_response"
          ? transportError.unusable(providerDetail.square())
          : transportError.unreachable(
              providerDetail.square(),
              "network_error",
            );
      expect(await readThrowing(error)).toEqual(read);
      expect(squareRefundFailure(error)).toEqual(refund);
    });
  }

  // A bug of ours is not Square's failure, so neither reading claims it and
  // the caller re-raises what it caught.
  test("claims nothing about an error Square does not own", async () => {
    const bug = new Error("internal bug");
    await expect(readThrowing(bug)).rejects.toThrow("internal bug");
    expect(squareRefundFailure(bug)).toBeUndefined();
  });

  test("reads a provider with nothing configured as unavailable", async () => {
    expect(
      await readSquareResource(() => Promise.resolve(null))(
        () => Promise.resolve({}),
        judgedBy([]),
      ),
    ).toEqual({ reason: "not_configured", status: "unavailable" });
  });
});
