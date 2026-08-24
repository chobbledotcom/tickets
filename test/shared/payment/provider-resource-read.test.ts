import { assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import type { ProviderRead } from "#payment/provider-read.ts";
import {
  judgedBy,
  judgeThrough,
  parsedBy,
  providerResourceReader,
  readProviderResource,
  refuseUnless,
  refuseUnlessAll,
} from "#payment/provider-resource-read.ts";

type Account = { token: string };

const account: Account = { token: "k" };
const found = <T>(resource: T): ProviderRead<T> => ({
  resource,
  status: "found",
});

const neverAsked = (): Promise<never> => {
  throw new Error("The provider must not be asked");
};

const neverJudged = (): never => {
  throw new Error("The answer must not be judged");
};

describe("provider resource read", () => {
  test("does not ask an unconfigured provider anything", async () => {
    expect(
      await readProviderResource({
        account: null,
        ask: neverAsked,
        failure: neverJudged,
        judge: neverJudged,
      }),
    ).toEqual({ reason: "not_configured", status: "unavailable" });
  });

  test("hands the account to the call and to the judging", async () => {
    expect(
      await readProviderResource({
        account,
        ask: (given) => Promise.resolve(given.token),
        failure: neverJudged,
        judge: (answer, given) => found(`${answer}:${given.token}`),
      }),
    ).toEqual(found("k:k"));
  });

  test("reads an answer that carries nothing as a resource not sent", async () => {
    for (const nothing of [null, undefined]) {
      expect(
        await readProviderResource({
          account,
          ask: () => Promise.resolve(nothing),
          failure: neverJudged,
          judge: neverJudged,
        }),
      ).toEqual({ reason: "missing_documented_resource", status: "invalid" });
    }
  });

  test("gives a failed call the meaning its failure reader proves", async () => {
    expect(
      await readProviderResource({
        account,
        ask: () => Promise.reject(new Error("down")),
        failure: () => ({ reason: "rate_limited", status: "unavailable" }),
        judge: neverJudged,
      }),
    ).toEqual({ reason: "rate_limited", status: "unavailable" });
  });

  test("lets a failure the provider does not own keep travelling", async () => {
    const ours = new Error("a bug of ours");
    await assertRejects(
      () =>
        readProviderResource({
          account,
          ask: () => Promise.reject(ours),
          failure: () => undefined,
          judge: neverJudged,
        }),
      Error,
      "a bug of ours",
    );
  });

  test("does not catch a bug in the judging step", async () => {
    await assertRejects(
      () =>
        readProviderResource({
          account,
          ask: () => Promise.resolve("answer"),
          failure: () => ({ status: "missing" }),
          judge: () => {
            throw new Error("judging bug");
          },
        }),
      Error,
      "judging bug",
    );
  });

  describe("bound to one provider", () => {
    const readOne = providerResourceReader(
      () => Promise.resolve(account),
      () => ({ reason: "timeout", status: "unavailable" }),
    );

    test("resolves the bound account for every read", async () => {
      expect(
        await readOne(
          (given) => Promise.resolve(given.token),
          (answer) => found(answer),
        ),
      ).toEqual(found("k"));
    });

    test("uses the bound failure reader for every read", async () => {
      expect(
        await readOne(() => Promise.reject(new Error("x")), neverJudged),
      ).toEqual({ reason: "timeout", status: "unavailable" });
    });

    test("reports a provider whose account will not resolve as unconfigured", async () => {
      const unconfigured = providerResourceReader(
        () => null,
        () => undefined,
      );
      expect(await unconfigured(neverAsked, neverJudged)).toEqual({
        reason: "not_configured",
        status: "unavailable",
      });
    });
  });

  describe("refusal ladder", () => {
    const Schema = v.object({
      id: v.optional(v.string()),
      state: v.optional(v.string()),
    });
    type Parsed = v.InferOutput<typeof Schema>;

    const judge = judgeThrough({
      accept: (parsed: Parsed) => parsed.id,
      parse: parsedBy(Schema),
      rungs: [
        refuseUnlessAll<Parsed>("missing_documented_resource", [
          (parsed) => parsed.id !== undefined,
          (parsed) => parsed.state !== undefined,
        ]),
        refuseUnless<Parsed>("mismatched_id", (parsed) => parsed.id === "a"),
        refuseUnless<Parsed>(
          "unsupported_status",
          (parsed) => parsed.state === "done",
        ),
      ],
    });

    test("accepts an answer that passes every rung", () => {
      expect(judge({ id: "a", state: "done" })).toEqual(found("a"));
    });

    test("refuses an answer that does not parse as malformed", () => {
      expect(judge("not an object")).toEqual({
        reason: "malformed_response",
        status: "invalid",
      });
    });

    test("stops at the first rung that names a reason", () => {
      // Both the missing-field rung and the id rung would refuse this answer.
      // The earlier one must win, so the reason names the first fact to break.
      expect(judge({ id: "b" })).toEqual({
        reason: "missing_documented_resource",
        status: "invalid",
      });
    });

    test("names the reason of the rung that actually broke", () => {
      expect(judge({ id: "b", state: "done" })).toEqual({
        reason: "mismatched_id",
        status: "invalid",
      });
      expect(judge({ id: "a", state: "waiting" })).toEqual({
        reason: "unsupported_status",
        status: "invalid",
      });
    });

    test("refuses when any one rule of a shared reason breaks", () => {
      const rung = refuseUnlessAll<Parsed>("mismatched_account", [
        (parsed) => parsed.id === "a",
        (parsed) => parsed.state === "done",
      ]);
      expect(rung({ id: "a", state: "done" })).toBe(null);
      expect(rung({ id: "b", state: "done" })).toBe("mismatched_account");
      expect(rung({ id: "a", state: "waiting" })).toBe("mismatched_account");
    });

    test("a rung passes an answer that holds", () => {
      const rung = refuseUnless<Parsed>("mismatched_id", () => true);
      expect(rung({ id: "anything" })).toBe(null);
    });

    test("lets the rungs alone decide an answer already in shape", () => {
      const judgeShaped = judgedBy<Parsed>([
        refuseUnless("mismatched_id", (parsed) => parsed.id === "a"),
      ]);
      expect(judgeShaped({ id: "a" })).toEqual(found({ id: "a" }));
      expect(judgeShaped({ id: "b" })).toEqual({
        reason: "mismatched_id",
        status: "invalid",
      });
    });

    test("reads an answer its schema rejects as no answer at all", () => {
      expect(parsedBy(Schema)({ id: 7 })).toBe(null);
      expect(parsedBy(Schema)({ id: "a" })).toEqual({ id: "a" });
    });
  });
});
