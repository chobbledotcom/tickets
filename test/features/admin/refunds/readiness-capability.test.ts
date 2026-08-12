import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { prepareRefundReadiness } from "#routes/admin/refunds/readiness.ts";
import type { PaymentReferenceProviderBindingRequest } from "#shared/db/payment-reference-provider.ts";
import {
  boundIndexes,
  candidate,
  charge,
  found,
  heldClaim,
  provider,
  tagged,
  untagged,
} from "./readiness/helpers.ts";

test("binds each resolved provider's capability to its reference", async () => {
  const stripe = provider("stripe");
  const sumup = provider("sumup", "keyless");
  const stripeReference = tagged("stripe_charge", "stripe");
  const sumupReference = untagged("sumup_charge");
  const references = [stripeReference, sumupReference];
  const bindingRequests: PaymentReferenceProviderBindingRequest[] = [];

  const result = await prepareRefundReadiness(
    [candidate(1, references)],
    {
      commandId: heldClaim.commandId,
      held: new Map([[1, references.map(({ index }) => `session_${index}`)]]),
      heldSince: heldClaim.heldSince,
      phases: new Map(
        references.map(({ index }) => [`session_${index}`, "checking"]),
      ),
    },
    new Set(),
    {
      bindProviders: (request) => {
        bindingRequests.push(request);
        return Promise.resolve({
          indexes: boundIndexes(request.bindings),
          kind: "bound",
        });
      },
      loadProvider: (type) =>
        Promise.resolve(type === "sumup" ? sumup : stripe),
      readEvidence: (reference) =>
        Promise.resolve(
          found(
            reference,
            reference.reference.startsWith("sumup") ? "sumup" : "stripe",
            charge(),
          ),
        ),
    },
  );

  expect(result.kind).toBe("ready");
  expect(
    result.kind === "ready" && result.candidates[0]?.references[0]?.kind,
  ).toBe("observed");
  expect(bindingRequests[0]?.bindings).toEqual(
    new Map([
      [
        stripeReference.index,
        {
          capability: "keyed",
          identity: {
            kind: "tagged",
            provider: "stripe",
            reference: "stripe_charge",
          },
        },
      ],
      [
        sumupReference.index,
        {
          capability: "keyless",
          identity: {
            kind: "tagged",
            provider: "sumup",
            reference: "sumup_charge",
          },
        },
      ],
    ]),
  );
});
