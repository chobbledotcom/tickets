import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { prepareRefundReadiness } from "#routes/admin/refunds/readiness.ts";
import {
  candidate,
  charge,
  heldClaim,
  provider,
  tagged,
} from "./readiness/helpers.ts";

test("keeps each tagged provider capability with its exact reference", async () => {
  const stripe = provider("stripe");
  const sumup = provider("sumup", "keyless");
  const stripeReference = tagged("stripe_charge", "stripe");
  const sumupReference = tagged("sumup_charge", "sumup");

  const result = await prepareRefundReadiness(
    [candidate(1, [stripeReference, sumupReference])],
    heldClaim,
    new Set(),
    {
      loadProvider: ({ provider: type }) => {
        const source = type === "sumup" ? sumup : stripe;
        return Promise.resolve({
          ...source,
          readCharge: () =>
            Promise.resolve({ resource: charge(), status: "found" }),
        });
      },
    },
  );

  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.candidates[0]?.references).toMatchObject([
    {
      kind: "observed",
      provider: { type: "stripe" },
      reference: stripeReference,
    },
    {
      kind: "observed",
      provider: { type: "sumup" },
      reference: sumupReference,
    },
  ]);
});
