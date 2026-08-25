/**
 * The one shell every payment provider call runs inside.
 *
 * Asking a provider for its records and telling it to move money are the same
 * four steps: check that the provider is configured at all, ask it, read what
 * it answered, and give a failed call its meaning. Only asking and reading the
 * answer differ per call, so only those two are passed in.
 */

/** What one provider call needs to know beyond the call itself. */
export type ProviderCall<Account, Answer, Result> = {
  /** The account facts the call needs, or null when nothing is configured. */
  account: Account | null;
  /** Ask the provider. */
  ask: (account: Account) => Promise<Answer>;
  /** The meaning of a caught provider failure, or nothing when the error is a
   *  bug of ours rather than the provider's. */
  failure: (error: unknown) => Result | undefined;
  /** What the answer means. */
  judge: (answer: Answer, account: Account) => Result;
  /** The answer when this provider is not configured at all. */
  unconfigured: Result;
};

/** Ask one provider one thing. Only the call itself is caught: a bug in the
 * reading step stays an internal error rather than becoming a provider
 * answer. */
export const askProvider = async <Account, Answer, Result>({
  account,
  ask,
  failure,
  judge,
  unconfigured,
}: ProviderCall<Account, Answer, Result>): Promise<Result> => {
  if (account === null) return unconfigured;
  let answer: Answer;
  try {
    answer = await ask(account);
  } catch (error) {
    const result = failure(error);
    if (result === undefined) throw error;
    return result;
  }
  return judge(answer, account);
};
