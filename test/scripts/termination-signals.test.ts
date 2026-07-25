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

test("continues to SIGTERM after SIGINT registration throws", () => {
  const calls: Deno.Signal[] = [];
  using _signal = stub(Deno, "addSignalListener", ((signal: Deno.Signal) => {
    calls.push(signal);
    if (signal === "SIGINT") throw new Error("unsupported signal");
  }) as typeof Deno.addSignalListener);
  onTerminationSignals(() => {});
  expect(calls).toEqual(["SIGINT", "SIGTERM"]);
});

test("continues to SIGTERM after SIGINT removal throws", () => {
  const calls: Deno.Signal[] = [];
  using _signal = stub(Deno, "removeSignalListener", ((signal: Deno.Signal) => {
    calls.push(signal);
    if (signal === "SIGINT") throw new Error("unsupported signal");
  }) as typeof Deno.removeSignalListener);
  offTerminationSignals(() => {});
  expect(calls).toEqual(["SIGINT", "SIGTERM"]);
});
