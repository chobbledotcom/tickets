import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { tryStep } from "#shared/try-step.ts";

test("tryStep returns the step's own outcome when it does not throw", async () => {
  const result = await tryStep("Deploy", () =>
    Promise.resolve({ ok: true as const, value: 42 }),
  );
  expect(result).toEqual({ ok: true, value: 42 });
});

test("tryStep turns a thrown Error into a labelled failure", async () => {
  const result = await tryStep("Deploy", () => {
    throw new Error("network down");
  });
  expect(result).toEqual({ error: "Deploy: network down", ok: false });
});

test("tryStep stringifies a non-Error thrown value", async () => {
  const result = await tryStep("Deploy", () => {
    // A bare string throw (not an Error) must not read `.message` off it.
    throw "boom";
  });
  expect(result).toEqual({ error: "Deploy: boom", ok: false });
});
