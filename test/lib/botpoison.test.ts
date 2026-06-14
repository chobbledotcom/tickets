import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { verifyBotpoisonSolution } from "#shared/botpoison.ts";
import { setTestEnv } from "#test-utils";

describe("verifyBotpoisonSolution", () => {
  let restoreEnv: () => void;
  let fetchStub: Stub | undefined;

  beforeEach(() => {
    restoreEnv = setTestEnv({ BOTPOISON_SECRET_KEY: "sk_test_secret" });
  });

  afterEach(() => {
    fetchStub?.restore();
    fetchStub = undefined;
    restoreEnv();
  });

  const stubFetch = (
    impl: (url: string, init?: RequestInit) => Promise<Response>,
  ): void => {
    fetchStub = stub(
      globalThis,
      "fetch",
      impl as unknown as typeof globalThis.fetch,
    );
  };

  test("returns false for an empty solution without calling the API", async () => {
    stubFetch(() => Promise.reject(new Error("should not be called")));
    expect(await verifyBotpoisonSolution("")).toBe(false);
    expect(fetchStub?.calls.length).toBe(0);
  });

  test("returns false when no secret key is configured", async () => {
    restoreEnv();
    restoreEnv = setTestEnv({ BOTPOISON_SECRET_KEY: undefined });
    stubFetch(() => Promise.reject(new Error("should not be called")));
    expect(await verifyBotpoisonSolution("solution-123")).toBe(false);
    expect(fetchStub?.calls.length).toBe(0);
  });

  test("posts the secret key and solution to the verify endpoint", async () => {
    let captured: { url: string; body: unknown } | null = null;
    stubFetch((url, init) => {
      captured = { body: JSON.parse(String(init?.body)), url };
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    });

    const result = await verifyBotpoisonSolution("solution-123");

    expect(result).toBe(true);
    expect(captured).toEqual({
      body: { secretKey: "sk_test_secret", solution: "solution-123" },
      url: "https://api.botpoison.com/verify",
    });
  });

  test("returns false when the API reports the solution is not ok", async () => {
    stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: false }))),
    );
    expect(await verifyBotpoisonSolution("bad-solution")).toBe(false);
  });

  test("returns false on a non-OK HTTP status", async () => {
    stubFetch(() => Promise.resolve(new Response("error", { status: 500 })));
    expect(await verifyBotpoisonSolution("solution-123")).toBe(false);
  });

  test("returns false when the network request throws", async () => {
    stubFetch(() => Promise.reject(new Error("network down")));
    expect(await verifyBotpoisonSolution("solution-123")).toBe(false);
  });

  test("returns false when the request rejects with a non-Error value", async () => {
    stubFetch(() => Promise.reject("boom"));
    expect(await verifyBotpoisonSolution("solution-123")).toBe(false);
  });

  test("returns false when the response body is not valid JSON", async () => {
    stubFetch(() => Promise.resolve(new Response("not json")));
    expect(await verifyBotpoisonSolution("solution-123")).toBe(false);
  });
});
