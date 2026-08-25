import { assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { askProvider } from "#payment/provider-call.ts";

type Account = { token: string };

const account: Account = { token: "k" };

const neverAsked = (): Promise<never> => {
  throw new Error("The provider must not be asked");
};

const neverRead = (): never => {
  throw new Error("The answer must not be read");
};

describe("provider call", () => {
  test("does not ask an unconfigured provider anything", async () => {
    expect(
      await askProvider({
        account: null,
        ask: neverAsked,
        failure: neverRead,
        judge: neverRead,
        unconfigured: "nothing is set up",
      }),
    ).toBe("nothing is set up");
  });

  test("hands the account to the call and to the reading", async () => {
    expect(
      await askProvider({
        account,
        ask: (given) => Promise.resolve(given.token.toUpperCase()),
        failure: neverRead,
        judge: (answer, given) => `${answer}:${given.token}`,
        unconfigured: "unused",
      }),
    ).toBe("K:k");
  });

  test("gives a failed call the meaning its failure reader proves", async () => {
    expect(
      await askProvider({
        account,
        ask: () => Promise.reject(new Error("429")),
        failure: (error) => `refused: ${(error as Error).message}`,
        judge: neverRead,
        unconfigured: "unused",
      }),
    ).toBe("refused: 429");
  });

  test("re-raises a failure the provider does not own", async () => {
    const ours = new Error("a bug of ours");
    await assertRejects(
      () =>
        askProvider({
          account,
          ask: () => Promise.reject(ours),
          failure: () => undefined,
          judge: neverRead,
          unconfigured: "unused",
        }),
      Error,
      "a bug of ours",
    );
  });

  // The reading step runs outside the catch, so a bug there stays our error
  // instead of being handed to the failure reader as a provider answer.
  test("does not read a broken reading step as a provider failure", async () => {
    await assertRejects(
      () =>
        askProvider({
          account,
          ask: () => Promise.resolve("answered"),
          failure: () => "the failure reader must not see this",
          judge: (): string => {
            throw new Error("reading step is broken");
          },
          unconfigured: "unused",
        }),
      Error,
      "reading step is broken",
    );
  });

  test("keeps an answer of nothing, because only a read calls that missing", async () => {
    expect(
      await askProvider({
        account,
        ask: () => Promise.resolve(null),
        failure: neverRead,
        judge: (answer) => `answered ${answer}`,
        unconfigured: "unused",
      }),
    ).toBe("answered null");
  });
});
