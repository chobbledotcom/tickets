import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  denoExitCode,
  offTerminationSignals,
  onTerminationSignals,
} from "../../scripts/mutation/child-process.ts";

test("an explicit child environment does not inherit removed parent values", async () => {
  const parentKey = "TICKETS_MUTATION_PARENT_ONLY";
  const previous = Deno.env.get(parentKey);
  Deno.env.set(parentKey, "must not leak");
  try {
    const code = await denoExitCode(
      [
        "eval",
        `Deno.exit(Deno.env.get("${parentKey}") === undefined && Deno.env.get("TICKETS_MUTATION_CHILD_ONLY") === "present" ? 0 : 1)`,
      ],
      { env: { TICKETS_MUTATION_CHILD_ONLY: "present" } },
    );

    expect(code).toBe(0);
  } finally {
    if (previous === undefined) Deno.env.delete(parentKey);
    else Deno.env.set(parentKey, previous);
  }
});

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
