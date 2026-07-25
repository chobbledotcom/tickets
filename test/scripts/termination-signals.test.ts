import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  offTerminationSignals,
  onTerminationSignals,
} from "#scripts/termination-signals.ts";

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
