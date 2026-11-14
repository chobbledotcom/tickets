import type { ProviderRead } from "#payment/provider-read.ts";
import type { StripePaidInvoice } from "#shared/stripe/schemas.ts";
import {
  renewalTax,
  type SubscriptionStatus,
} from "#shared/subscriptions/plan.ts";
import type { RenewalFacts } from "./renewal-facts.ts";

export type InvoiceInput = {
  amount: number;
  id: string;
  paidAt?: number;
  reason: string | null;
};

export type RenewalPass = {
  fault: boolean;
  invoices: readonly InvoiceInput[];
  observed: SubscriptionStatus;
  read: ProviderRead<readonly StripePaidInvoice[]>["status"];
};

export type IdentityChange =
  | "id"
  | "attendee"
  | "listing"
  | "subscription"
  | "status";
export type RenewalCase = {
  change?: IdentityChange;
  name: string;
  passes: readonly RenewalPass[];
  price: number;
  tax: number;
};

const cycle = (amount = 600, id = "a"): InvoiceInput => ({
  amount,
  id,
  reason: "subscription_cycle",
});

const pass = (
  invoices: readonly InvoiceInput[],
  overrides: Partial<Omit<RenewalPass, "invoices">> = {},
): RenewalPass => ({
  fault: false,
  invoices,
  observed: "active",
  read: "found",
  ...overrides,
});

const scenario = (
  name: string,
  passes: readonly RenewalPass[],
  options: Partial<Pick<RenewalCase, "change" | "price" | "tax">> = {},
): RenewalCase => ({ name, passes, price: 600, tax: 100, ...options });

const identityCase = (change: Exclude<IdentityChange, "status">): RenewalCase =>
  scenario(`identity_${change}`, [pass([cycle()])], { change });

const refusedReadCase = (
  read: Exclude<RenewalPass["read"], "found">,
): RenewalCase =>
  scenario(`read_${read}`, [pass([cycle()], { observed: "canceled", read })]);

const NON_RENEWAL_REASONS = {
  changed: "subscription_update",
  first: "subscription_create",
  manual: "manual",
} as const;

/** Each pass supplies a separate provider list, even when invoice ids repeat. */
export const RENEWAL_CASES: readonly RenewalCase[] = [
  scenario("normal", [pass([cycle()]), pass([cycle()])]),
  scenario("partial", [pass([cycle(303)])]),
  scenario("tax_only", [pass([cycle(1)])], { price: 2, tax: 1 }),
  scenario("no_tax", [pass([cycle()])], { tax: 0 }),
  scenario("excess", [pass([cycle(900)])]),
  scenario("non_renewals", [
    pass([
      cycle(0, "zero"),
      ...Object.entries(NON_RENEWAL_REASONS).map(([id, reason]) => ({
        ...cycle(600, id),
        reason,
      })),
      { ...cycle(600, "unknown"), reason: null },
    ]),
  ]),
  scenario("hundred", [
    pass(
      Array.from({ length: 100 }, (_, index) => cycle(600, `paid_${index}`)),
    ),
  ]),
  scenario("empty", [pass([], { observed: "canceled" })]),
  scenario("conflict", [
    pass([cycle()]),
    pass([cycle(601)], { observed: "canceled" }),
  ]),
  scenario("rollback", [
    pass([cycle()], { fault: true, observed: "canceled" }),
    pass([cycle()], { observed: "canceled" }),
  ]),
  scenario("stale_status", [pass([cycle()], { observed: "past_due" })], {
    change: "status",
  }),
  ...(["id", "attendee", "listing", "subscription"] as const).map(identityCase),
  ...(["missing", "invalid", "unavailable"] as const).map(refusedReadCase),
];

const STANDARD_AMOUNTS = {
  above_plan: 601,
  below_one: 1,
  below_plan: 599,
  excess: 900,
  half_up: 303,
  planned: 600,
  zero: 0,
} as const;

/** These check local integer arithmetic, not admission of a very large Stripe charge. */
export const arithmeticFacts = (): RenewalFacts["arithmetic"] => {
  const inputs = [
    ...Object.entries(STANDARD_AMOUNTS).map(([caseId, amount]) => ({
      amount,
      caseId,
      price: 600,
      tax: 100,
    })),
    { amount: 1, caseId: "tax_only", price: 2, tax: 1 },
    { amount: 900, caseId: "no_tax", price: 600, tax: 0 },
    {
      amount: 200_000_004,
      caseId: "below_half",
      price: 200_000_003,
      tax: 100_000_001,
    },
    {
      amount: Number.MAX_SAFE_INTEGER - 1,
      caseId: "large",
      price: Number.MAX_SAFE_INTEGER - 2,
      tax: 2_251_799_813_685_246,
    },
  ];
  return inputs.map((input) => ({
    ...input,
    observedTax: renewalTax(
      { price: input.price, tax: input.tax },
      input.amount,
    ),
  }));
};
