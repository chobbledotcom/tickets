import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  denoExitCode,
  offTerminationSignals,
  onTerminationSignals,
} from "#scripts/mutation/child-process.ts";

const PARENT_KEY = "TICKETS_MUTATION_PARENT_ONLY";

const withParentVariable = async <T>(
  value: string,
  run: () => Promise<T>,
): Promise<T> => {
  const previous = Deno.env.get(PARENT_KEY);
  Deno.env.set(PARENT_KEY, value);
  try {
    return await run();
  } finally {
    if (previous === undefined) Deno.env.delete(PARENT_KEY);
    else Deno.env.set(PARENT_KEY, previous);
  }
};

test("an explicit child environment does not inherit removed parent values", () =>
  withParentVariable("must not leak", async () => {
    const options = {
      clearEnv: false,
      env: { TICKETS_MUTATION_CHILD_ONLY: "present" },
    };
    const code = await denoExitCode(
      [
        "eval",
        `Deno.exit(Deno.env.get("${PARENT_KEY}") === undefined && Deno.env.get("TICKETS_MUTATION_CHILD_ONLY") === "present" ? 0 : 1)`,
      ],
      options,
    );

    expect(code).toBe(0);
  }));

test("a child without an explicit environment inherits parent values", () =>
  withParentVariable("must inherit", async () => {
    const code = await denoExitCode([
      "eval",
      `Deno.exit(Deno.env.get("${PARENT_KEY}") === "must inherit" ? 0 : 1)`,
    ]);

    expect(code).toBe(0);
  }));

const expectBothTerminationSignals = (
  method: "addSignalListener" | "removeSignalListener",
  listen: (handler: () => void) => void,
): void => {
  const handler = () => {};
  const calls: [Deno.Signal, () => void][] = [];
  using _signal = stub(Deno, method, ((signal, listener) =>
    calls.push([signal, listener])) as typeof Deno.addSignalListener);

  listen(handler);

  expect(calls).toEqual([
    ["SIGINT", handler],
    ["SIGTERM", handler],
  ]);
};

test("registers the termination handler for interrupt and terminate signals", () => {
  expectBothTerminationSignals("addSignalListener", onTerminationSignals);
});

test("unregisters the termination handler for interrupt and terminate signals", () => {
  expectBothTerminationSignals("removeSignalListener", offTerminationSignals);
});
