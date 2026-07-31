import type { PaymentWork } from "#routes/api/webhook-types.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import type { TxScope } from "#shared/db/client.ts";
import {
  applyPaymentSessionClaim,
  applyPaymentSessionClaimKeepingLease,
  type RetainedPaymentSessionClaim,
  releasePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import type {
  PaymentCompletion,
  PaymentCompletionEffect,
  PaymentEffectState,
} from "#shared/payment-completion.ts";
import { paymentProgress } from "#shared/payment-runtime/progress.ts";

export const COMPLETION_RETRY_MS = 60_000;
export type CompletionCurrent = RetainedPaymentSessionClaim;
export type CompletionRunMode = "all" | "critical";

export type CompletionStep<T, P extends PaymentCompletion = PaymentCompletion> =
  | {
      completion?: P;
      current: CompletionCurrent;
      kind: "completed";
    }
  | {
      completion?: P;
      current: CompletionCurrent;
      kind: "paused";
      nextReconcileAt: number | null;
      result: T;
    }
  | { current: CompletionCurrent; error: unknown; kind: "failed" };

type CompletionPlan<E extends PaymentCompletionEffect> = PaymentCompletion & {
  effects: Record<E, PaymentEffectState>;
};

const completedPlan = <
  E extends PaymentCompletionEffect,
  P extends CompletionPlan<E>,
>(
  plan: P,
  effect: E,
): P => ({
  ...plan,
  effects: completedEffectStates(plan.effects, effect),
});

type CompletionPosition<P extends PaymentCompletion> = {
  current: CompletionCurrent;
  plan: P;
};

type AppliedCompletionStep<T> =
  | { kind: "continue" }
  | { kind: "finished"; result: T };

const applyCompletionStep = async <
  E extends PaymentCompletionEffect,
  P extends CompletionPlan<E>,
  T,
>(
  position: CompletionPosition<P>,
  effect: E,
  step: CompletionStep<T, P>,
): Promise<AppliedCompletionStep<T>> => {
  position.current = step.current;
  if (step.kind === "failed") throw step.error;
  if (step.completion !== undefined) position.plan = step.completion;
  if (step.kind === "paused") {
    if (step.completion !== undefined) {
      position.current = await saveCompletionPlan(
        position.current,
        position.plan,
      );
    }
    await releasePaymentSessionClaim(
      position.current.claim,
      step.nextReconcileAt,
    );
    return { kind: "finished", result: step.result };
  }
  position.plan = completedPlan(position.plan, effect);
  position.current = await saveCompletionPlan(position.current, position.plan);
  return { kind: "continue" };
};

const deferCompletion = async <P extends PaymentCompletion, T>(
  position: CompletionPosition<P>,
  result: (current: CompletionCurrent, plan: P) => T,
): Promise<T> => {
  await releasePaymentSessionClaim(position.current.claim, Date.now());
  return result(position.current, position.plan);
};

const runCompletionPlan = async <
  E extends PaymentCompletionEffect,
  P extends CompletionPlan<E>,
  T,
>(
  initial: CompletionCurrent,
  initialPlan: P,
  effects: readonly E[],
  criticalEffects: readonly E[],
  mode: CompletionRunMode,
  run: (
    effect: E,
    current: CompletionCurrent,
    plan: P,
  ) => Promise<CompletionStep<T, P>>,
  result: (current: CompletionCurrent, plan: P) => T,
  finish: (current: CompletionCurrent, plan: P) => Promise<T>,
): Promise<T> => {
  const position = { current: initial, plan: initialPlan };
  try {
    for (const effect of effects) {
      if (position.plan.effects[effect] === "completed") continue;
      if (mode === "critical" && !criticalEffects.includes(effect)) {
        return deferCompletion(position, result);
      }
      const applied = await applyCompletionStep(
        position,
        effect,
        await run(effect, position.current, position.plan),
      );
      if (applied.kind === "finished") return applied.result;
    }
    return await finish(position.current, position.plan);
  } catch (error) {
    await releasePaymentSessionClaim(position.current.claim, Date.now());
    throw error;
  }
};

export type CompletionHandler<A, T> = (
  work: PaymentWork,
  actions?: A,
  mode?: CompletionRunMode,
) => Promise<T>;

interface CompletionDefinition<
  E extends PaymentCompletionEffect,
  P extends CompletionPlan<E>,
  A,
  C,
  T,
> {
  actions: A;
  criticalEffects: readonly E[];
  effects: readonly E[];
  finish: (current: CompletionCurrent, plan: P, context: C) => Promise<T>;
  label: string;
  matches: (completion: PaymentCompletion) => completion is P;
  prepare: (work: PaymentWork, plan: P) => C;
  result: (current: CompletionCurrent, plan: P) => T;
  run: (
    effect: E,
    current: CompletionCurrent,
    plan: P,
    context: C,
    actions: A,
  ) => Promise<CompletionStep<T, P>>;
}

export const definePaymentCompletion =
  <E extends PaymentCompletionEffect, P extends CompletionPlan<E>, A, C, T>(
    definition: CompletionDefinition<E, P, A, C, T>,
  ): CompletionHandler<A, T> =>
  async (work, actions = definition.actions, mode = "all") => {
    const plan = work.payment.completion;
    if (plan === null || !definition.matches(plan)) {
      throw new Error(
        `Payment ${work.payment.id} has no ${definition.label} completion`,
      );
    }
    const context = definition.prepare(work, plan);
    return runCompletionPlan(
      { claim: work.claim, payment: work.payment },
      plan,
      definition.effects,
      definition.criticalEffects,
      mode,
      (effect, current, currentPlan) =>
        definition.run(effect, current, currentPlan, context, actions),
      definition.result,
      (current, currentPlan) =>
        definition.finish(current, currentPlan, context),
    );
  };

export const paymentWorkWithCompletion = (
  work: PaymentWork,
  attendeeId: number,
  completion: PaymentCompletion,
  ticketTokens: string[],
): PaymentWork => ({
  ...work,
  payment: {
    ...work.payment,
    attendeeId,
    completion,
    completionState: "pending",
    ticketState: ticketTokens.length === 0 ? "consumed" : "ready",
    ticketTokens: ticketTokens.length === 0 ? null : ticketTokens,
  },
});

const completedEffectStates = <E extends PropertyKey>(
  effects: Record<E, PaymentEffectState>,
  effect: E,
): Record<E, PaymentEffectState> => ({
  ...effects,
  [effect]: "completed",
});

const saveCompletionPlan = async (
  current: CompletionCurrent,
  completion: PaymentCompletion,
): Promise<CompletionCurrent> =>
  applyPaymentSessionClaimKeepingLease(
    current.claim,
    paymentProgress(current.payment, {
      completion,
      completionState: "pending",
      nextReconcileAt: Date.now() + COMPLETION_RETRY_MS,
      state: current.payment.state,
    }),
  );

export const completionAttendeeId = (current: CompletionCurrent): number => {
  const attendeeId = current.payment.attendeeId;
  if (attendeeId === null) {
    throw new Error(`Payment ${current.payment.id} has no completion attendee`);
  }
  return attendeeId;
};

export const logCompletionActivity = (
  current: CompletionCurrent,
  message: string,
  listingId: number,
  transaction: TxScope,
): Promise<unknown> =>
  logActivity(message, listingId, completionAttendeeId(current), transaction);

export const finishCompletion = (
  current: CompletionCurrent,
  completion: PaymentCompletion,
  state: "completed" | "fully_refunded",
): Promise<unknown> =>
  applyPaymentSessionClaim(
    current.claim,
    paymentProgress(current.payment, {
      completion,
      completionState: "completed",
      nextReconcileAt: null,
      state:
        current.payment.state === "fully_refunded" ? "fully_refunded" : state,
    }),
  );

export const completedStep = <
  T,
  P extends PaymentCompletion = PaymentCompletion,
>(
  current: CompletionCurrent,
  completion?: P,
): CompletionStep<T, P> =>
  completion === undefined
    ? { current, kind: "completed" }
    : { completion, current, kind: "completed" };
