// test-groups: run-alone
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { executeBatch } from "#db/client.ts";
import { checkoutFacts } from "#scripts/verify-models/subscriptions/checkout.ts";

const requestScenarios = Array.from(
  { length: 40 },
  (_, index) => `checkout-${index + 1}`,
);
const allScenarios = [...requestScenarios, "local-41", "local-42", "local-43"];

/** Runs one statement on the stored rows before the producer reads them. */
const storedWrite = (sql: string) => ({
  stored: async () => {
    await executeBatch([{ args: [], sql }]);
  },
});

/** Each fact's observed number must be one fixed amount above its expected
 * number, with one fact for each scenario in order. */
const expectExcess = <Fact extends { scenario: string }>(
  facts: readonly Fact[],
  excess: (fact: Fact) => number,
  scenarios: readonly string[],
  amount: number,
) =>
  expect(
    facts.map((fact) => ({ excess: excess(fact), scenario: fact.scenario })),
  ).toEqual(scenarios.map((scenario) => ({ excess: amount, scenario })));

describe("subscription checkout boundary faults", () => {
  test("a changed recurring request amount reaches every extracted request", async () => {
    const facts = await checkoutFacts({
      request: (params) => ({
        ...params,
        line_items: params.line_items.map((line) =>
          line.price_data.recurring
            ? {
                ...line,
                price_data: {
                  ...line.price_data,
                  unit_amount: line.price_data.unit_amount + 1,
                },
              }
            : line,
        ),
      }),
    });
    expectExcess(
      facts.requests,
      (f) => f.recurringAmount - f.expectedAmount,
      requestScenarios,
      1,
    );
  });

  test("a changed supplied provider amount is stored on its true booking", async () => {
    const facts = await checkoutFacts({
      subscription: (resource) => ({
        ...resource,
        items: {
          data: [
            {
              ...resource.items.data[0],
              price: {
                ...resource.items.data[0].price,
                unit_amount: resource.items.data[0].price.unit_amount + 1,
              },
            },
          ],
        },
      }),
    });
    const owned = facts.plans.filter(
      (f) => f.owned && f.scenario.startsWith("checkout-"),
    );
    expectExcess(
      owned,
      (f) => f.amount - f.expectedAmount,
      requestScenarios.flatMap((scenario) => [scenario, scenario]),
      1,
    );
    expect(owned.map((f) => `${f.stage}-${f.booking}`)).toEqual(
      requestScenarios.flatMap((_, index) => [
        `stored-${(index + 1) * 100 + 5}`,
        `edited-${(index + 1) * 100 + 5}`,
      ]),
    );
  });

  test("a stored amount rewrite remains seven units wrong after the real edits", async () => {
    const facts = await checkoutFacts(
      storedWrite(
        "UPDATE listing_attendees SET recurring_price = recurring_price + 7 WHERE subscription_id <> ''",
      ),
    );
    expectExcess(
      facts.plans.filter((f) => f.owned && f.stage === "edited"),
      (f) => f.amount - f.expectedAmount,
      allScenarios,
      7,
    );
  });

  test("plans written onto ordinary rows remain wrongly attributed", async () => {
    const facts = await checkoutFacts(
      storedWrite(
        "UPDATE listing_attendees SET subscription_id = 'sub_wrong_row' WHERE recurring_price = 0",
      ),
    );
    expect(
      facts.plans
        .filter(
          (f) =>
            !f.owned && f.stage === "edited" && f.expectedSubscription === "",
        )
        .map((f) => ({
          expectedSubscription: f.expectedSubscription,
          identity: f.identity,
          subscription: f.subscription,
        })),
    ).toEqual(
      allScenarios.flatMap((scenario, index) =>
        [1, 2, 3, 4].map((row) => ({
          expectedSubscription: "",
          identity: `${scenario}-edited-${(index + 1) * 100 + row}`,
          subscription: "sub_wrong_row",
        })),
      ),
    );
  });

  test("an unbooked listing returned by the provider is an extraction error", async () => {
    await expect(
      checkoutFacts({
        subscription: (resource) => ({
          ...resource,
          metadata: { listing_id: "999999" },
        }),
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("another invoice identity cannot substitute for the session invoice", async () => {
    await expect(
      checkoutFacts({
        invoice: (invoice) => ({
          ...invoice,
          id: "in_not_the_session_invoice",
        }),
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("a wrong selected subscription records the actual read and rejects the mismatched reply", async () => {
    const reads: string[] = [];
    await expect(
      checkoutFacts({
        session: (session) => ({
          ...session,
          subscription: "sub_wrong_selected",
        }),
        subscriptionRead: (id) => reads.push(id),
      }),
    ).rejects.toThrow(
      /subscription sub_wrong_selected.*"reason":"mismatched_id"/,
    );
    expect(reads).toEqual(["sub_wrong_selected"]);
  });

  test("a wrong paid intent remains the observed first-payment reference", async () => {
    const facts = await checkoutFacts({
      invoice: (invoice) => ({
        ...invoice,
        payments: {
          data: invoice.payments.data.map((entry) =>
            entry.status === "paid" && entry.payment.type === "payment_intent"
              ? {
                  ...entry,
                  payment: {
                    ...entry.payment,
                    payment_intent: "pi_wrong_first_payment",
                  },
                }
              : entry,
          ),
        },
      }),
    });
    expect(
      facts.requests.map((f) => ({
        expected: f.expectedReference,
        observed: f.paymentReference,
        scenario: f.scenario,
      })),
    ).toEqual(
      requestScenarios.map((scenario, index) => ({
        expected: `pi_first_${index + 1}`,
        observed: "pi_wrong_first_payment",
        scenario,
      })),
    );
  });

  test("a one-second recurring timing fault survives extraction exactly", async () => {
    const facts = await checkoutFacts({
      request: (params) => {
        if (params.subscription_data === undefined)
          throw new Error("No recurring request to perturb");
        return {
          ...params,
          subscription_data: {
            ...params.subscription_data,
            trial_end: params.subscription_data.trial_end + 1,
          },
        };
      },
    });
    expectExcess(
      facts.requests,
      (f) => f.trialEnd - f.expectedTrialEnd,
      requestScenarios,
      1,
    );
  });

  test("a missing persisted subscribed row cannot become a default plan", async () => {
    await expect(
      checkoutFacts(
        storedWrite(
          "DELETE FROM listing_attendees WHERE subscription_id <> ''",
        ),
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  test("unexpected client boundary errors retain their identity", async () => {
    const fault = new Error("synthetic boundary fault");
    await expect(
      checkoutFacts({
        request: () => {
          throw fault;
        },
      }),
    ).rejects.toBe(fault);
  });
});
