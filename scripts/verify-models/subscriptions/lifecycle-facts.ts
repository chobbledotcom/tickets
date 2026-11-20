/** The states that one subscribed row can hold, and the two commands that run
 * against each state. */
import { SubscriptionStatusSchema } from "#shared/subscriptions/plan.ts";
import type { FactsOf } from "./controls.ts";

/* jscpd:ignore-start -- a list of strings, not code */
export const LIFECYCLE_TABLES = {
  moves: [
    "Moves",
    {
      cancels: "Int",
      command: "Str",
      invoiceReads: "Int",
      otherLegs: "Int",
      outcome: "Str",
      paid: "Int",
      position: "Int",
      provider: "Str",
      providerAfter: "Str",
      reads: "Int",
      recorded: "Int",
      recordedAfter: "Int",
      reply: "Str",
      scenario: "Str",
      stored: "Str",
      storedAfter: "Str",
    },
  ],
} as const;
/* jscpd:ignore-end */

export type LifecycleFacts = FactsOf<typeof LIFECYCLE_TABLES>;

export const LIFECYCLE_COMMANDS = ["check", "cancel"] as const;

/** How Stripe replies: it answers each request, it refuses the subscription
 * requests, or it refuses the paid invoice read. */
export const LIFECYCLE_REPLIES = [
  "answers",
  "subscription-refused",
  "invoices-refused",
] as const;

/** Each pair is the renewals that Stripe holds as paid, then the renewals
 * that the ledger holds. */
const LEDGERS = [
  [0, 0],
  [1, 0],
  [1, 1],
] as const;

export type LifecycleCase = {
  command: (typeof LIFECYCLE_COMMANDS)[number];
  paid: number;
  provider: (typeof SubscriptionStatusSchema.options)[number];
  recorded: number;
  reply: (typeof LIFECYCLE_REPLIES)[number];
  stored: (typeof SubscriptionStatusSchema.options)[number];
};

export const lifecycleScenario = (sample: LifecycleCase): string =>
  [
    sample.command,
    sample.reply,
    sample.stored,
    sample.provider,
    sample.paid,
    sample.recorded,
  ].join("/");

type Status = LifecycleCase["stored"];
type State = Pick<LifecycleCase, "paid" | "provider" | "recorded" | "stored">;

const statesWith = (stored: Status, provider: Status): State[] =>
  LEDGERS.map(([paid, recorded]) => ({ paid, provider, recorded, stored }));

const statesStoredAs = (stored: Status): State[] =>
  SubscriptionStatusSchema.options.flatMap((provider) =>
    statesWith(stored, provider),
  );

const repliesTo = (command: LifecycleCase["command"]) =>
  LIFECYCLE_REPLIES.map((reply) => ({ command, reply }));

/** Every command against every state and reply. The list exists before any
 * command runs, so a lost outcome cannot leave the expectation. */
export const lifecycleCases = (): LifecycleCase[] => {
  const states = SubscriptionStatusSchema.options.flatMap(statesStoredAs);
  return LIFECYCLE_COMMANDS.flatMap(repliesTo).flatMap((run) =>
    states.map((state) => ({ ...run, ...state })),
  );
};
