/**
 * The one shell every provider read runs inside.
 *
 * A read of a provider's records is the same four steps for all three
 * providers: check that the provider is configured at all, ask it, judge the
 * answer against facts we hold independently, and give a failed call its
 * {@link ProviderRead} meaning. Only asking and judging differ per provider,
 * so only those two are passed in.
 *
 * "Absent" means one thing here, for every provider: a call that comes back
 * with nothing is a documented resource the provider did not send, never a
 * provider that is not configured and never a malformed answer.
 *
 * The judging step is declared as a ladder of refusals rather than written as
 * a chain of `if`s, so each refusal sits beside the reason it returns and a
 * new rung is one entry rather than one more arm.
 */

import * as v from "valibot";
import { malformedProviderRead } from "#payment/provider-failures.ts";
import type {
  ProviderInvalidReason,
  ProviderRead,
} from "#payment/provider-read.ts";

const MISSING: ProviderRead<never> = {
  reason: "missing_documented_resource",
  status: "invalid",
};

/** What one provider read needs to know beyond the call itself. */
export type ProviderResourceRead<Account, Answer, Resource> = {
  /** The account facts the call needs, or null when nothing is configured. */
  account: Account | null;
  /** Ask the provider. Unwrap any envelope here, so an answer that carries no
   *  resource comes back as null. */
  ask: (account: Account) => Promise<Answer | null | undefined>;
  /** Judge the answer: the resource, or the one reason it is refused. */
  judge: (answer: Answer, account: Account) => ProviderRead<Resource>;
  /** The read meaning of a caught provider failure, or nothing when the error
   *  is a bug of ours rather than the provider's. */
  failure: (error: unknown) => ProviderRead<never> | undefined;
};

/** Read one provider resource. Only the call is caught: a bug in the judging
 * step stays an internal error rather than becoming a provider answer. */
export const readProviderResource = async <Account, Answer, Resource>({
  account,
  ask,
  judge,
  failure,
}: ProviderResourceRead<Account, Answer, Resource>): Promise<
  ProviderRead<Resource>
> => {
  if (account === null) {
    return { reason: "not_configured", status: "unavailable" };
  }
  let answer: Answer | null | undefined;
  try {
    answer = await ask(account);
  } catch (error) {
    const read = failure(error);
    if (read === undefined) throw error;
    return read;
  }
  if (answer === null || answer === undefined) return MISSING;
  return judge(answer, account);
};

/** One provider's reads, once its account and failure reading are bound. The
 *  call and the judging are the only two things one read differs by. */
export type ResourceReader<Account> = <Answer, Resource>(
  ask: (account: Account) => Promise<Answer | null | undefined>,
  judge: (answer: Answer, account: Account) => ProviderRead<Resource>,
) => Promise<ProviderRead<Resource>>;

/** Bind one provider's way of resolving its account and of reading a failed
 * call, so no read has to repeat either. */
export const providerResourceReader =
  <Account>(
    account: () => Account | null | Promise<Account | null>,
    failure: (error: unknown) => ProviderRead<never> | undefined,
  ): ResourceReader<Account> =>
  async (ask, judge) =>
    readProviderResource({ account: await account(), ask, failure, judge });

/** One rung of a refusal ladder: it names the reason the answer is refused, or
 *  null when the answer passes this rung. */
export type Rung<Answer> = (answer: Answer) => ProviderInvalidReason | null;

/** Refuse an answer that breaks a rule, naming the rule it broke. */
export const refuseUnless =
  <Answer>(
    reason: ProviderInvalidReason,
    holds: (answer: Answer) => boolean,
  ): Rung<Answer> =>
  (answer) =>
    holds(answer) ? null : reason;

/** Refuse an answer that breaks any of several rules that share one reason. */
export const refuseUnlessAll = <Answer>(
  reason: ProviderInvalidReason,
  rules: readonly ((answer: Answer) => boolean)[],
): Rung<Answer> =>
  refuseUnless(reason, (answer) => rules.every((holds) => holds(answer)));

/** Build the judging step from a parse and a ladder of refusals.
 *
 * An answer that does not parse is malformed. Each rung is then asked in turn,
 * and the first to name a reason ends the read. An answer that passes every
 * rung becomes the resource. */
export const judgeThrough =
  <Answer, Parsed, Resource>(steps: {
    parse: (answer: Answer) => Parsed | null;
    rungs: readonly Rung<Parsed>[];
    accept: (parsed: Parsed) => Resource;
  }) =>
  (answer: Answer): ProviderRead<Resource> => {
    const parsed = steps.parse(answer);
    if (parsed === null) return malformedProviderRead();
    for (const rung of steps.rungs) {
      const reason = rung(parsed);
      if (reason !== null) return { reason, status: "invalid" };
    }
    return { resource: steps.accept(parsed), status: "found" };
  };

/** The judging step for an answer that is already the resource, so only the
 *  rungs decide. Use it when the transport has parsed the answer already. */
export const judgedBy = <Answer>(
  rungs: readonly Rung<Answer>[],
): ((answer: Answer) => ProviderRead<Answer>) =>
  judgeThrough<Answer, Answer, Answer>({
    accept: (answer) => answer,
    parse: (answer) => answer,
    rungs,
  });

/** The `parse` step for a ladder whose parse is only its schema. A schema
 *  failure is the answer not matching its documented shape. */
export const parsedBy =
  <Parsed>(schema: v.BaseSchema<unknown, Parsed, v.BaseIssue<unknown>>) =>
  (answer: unknown): Parsed | null => {
    const parsed = v.safeParse(schema, answer);
    return parsed.success ? parsed.output : null;
  };
