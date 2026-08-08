import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { evaluateStaticMutants } from "#scripts/mutation/static.ts";
import {
  config,
  fakeWorkspace,
  mutants,
  passingGate,
  plan,
} from "./static-helpers.ts";

const aggregateErrorMessages = async (
  promise: Promise<unknown>,
): Promise<string[]> => {
  try {
    await promise;
    throw new Error("Expected an aggregate error");
  } catch (error) {
    if (!(error instanceof AggregateError)) throw error;
    return error.errors.map((item) => String(item));
  }
};

describe("parallel mutation static cleanup", () => {
  test("preserves serial gate and source restore errors", async () => {
    const work = fakeWorkspace();
    work.deps.write = (_file, content) =>
      content === "true"
        ? Promise.reject(new Error("restore failed"))
        : Promise.resolve();
    expect(
      await aggregateErrorMessages(
        evaluateStaticMutants(
          plan(mutants.slice(0, 1)),
          [passingGate(() => Promise.reject(new Error("gate failed")))],
          config(),
          work.deps,
        ),
      ),
    ).toEqual(["Error: gate failed", "Error: restore failed"]);
  });

  test("cleans every copy after gate errors", async () => {
    const work = fakeWorkspace();
    expect(
      await aggregateErrorMessages(
        evaluateStaticMutants(
          plan(mutants.slice(0, 3)),
          [
            passingGate(() =>
              Promise.reject(new Error("type checker could not start")),
            ),
          ],
          config(),
          work.deps,
        ),
      ),
    ).toEqual([
      "Error: type checker could not start",
      "Error: type checker could not start",
      "Error: type checker could not start",
    ]);
    expect(work.removed).toEqual(work.copied);
  });

  test("waits for every workspace copy before cleanup", async () => {
    const work = fakeWorkspace();
    const laterCopy = Promise.withResolvers<void>();
    const events: string[] = [];
    work.deps.copy = async (_from, to) => {
      events.push(`copy ${to}`);
      if (to === "/run/static-1") throw new Error("copy failed");
      await laterCopy.promise;
      events.push(`copied ${to}`);
    };
    work.deps.remove = (path) => {
      events.push(`removed ${path}`);
      return Promise.resolve();
    };

    const evaluated = evaluateStaticMutants(
      plan(mutants.slice(0, 3)),
      [passingGate(() => Promise.resolve(0))],
      config(),
      work.deps,
    );
    await Promise.resolve();
    expect(events).toEqual([
      "copy /run/static-1",
      "copy /run/static-2",
      "copy /run/static-3",
    ]);
    laterCopy.resolve();

    await expect(evaluated).rejects.toThrow("copy failed");
    expect(events.indexOf("copied /run/static-2")).toBeLessThan(
      events.indexOf("removed /run/static-2"),
    );
    expect(events.indexOf("copied /run/static-3")).toBeLessThan(
      events.indexOf("removed /run/static-3"),
    );
  });

  test("preserves every workspace copy error", async () => {
    const work = fakeWorkspace();
    work.deps.copy = (_from, to) =>
      to === "/run/static-3"
        ? Promise.resolve()
        : Promise.reject(new Error(`copy failed: ${to}`));

    expect(
      await aggregateErrorMessages(
        evaluateStaticMutants(
          plan(mutants.slice(0, 3)),
          [passingGate(() => Promise.resolve(0))],
          config(),
          work.deps,
        ),
      ),
    ).toEqual([
      "Error: copy failed: /run/static-1",
      "Error: copy failed: /run/static-2",
    ]);
  });

  test("waits for every workspace removal after one fails", async () => {
    const work = fakeWorkspace();
    const laterRemoval = Promise.withResolvers<void>();
    const removalsStarted = Promise.withResolvers<void>();
    const outcome = Promise.withResolvers<string>();
    work.deps.remove = async (path) => {
      work.removed.push(path);
      if (work.removed.length === 3) removalsStarted.resolve();
      if (path === "/run/static-1") throw new Error("removal failed");
      await laterRemoval.promise;
    };

    const evaluated = evaluateStaticMutants(
      plan(mutants.slice(0, 3)),
      [passingGate(() => Promise.resolve(0))],
      config(),
      work.deps,
    );
    const recordOutcome = async (): Promise<void> => {
      try {
        await evaluated;
        outcome.resolve("resolved");
      } catch {
        outcome.resolve("rejected");
      }
    };
    void recordOutcome();
    await removalsStarted.promise;
    const laterTurn = Promise.withResolvers<string>();
    let turns = 5;
    const passTurn = (): void => {
      turns -= 1;
      if (turns === 0) laterTurn.resolve("still removing");
      else queueMicrotask(passTurn);
    };
    queueMicrotask(passTurn);
    expect(await Promise.race([outcome.promise, laterTurn.promise])).toBe(
      "still removing",
    );

    laterRemoval.resolve();
    await expect(evaluated).rejects.toThrow("removal failed");
  });

  test("preserves worker and cleanup errors", async () => {
    const work = fakeWorkspace();
    let gateCalls = 0;
    work.deps.remove = (path) =>
      path === "/run/static-1"
        ? Promise.reject(new Error("cleanup failed"))
        : Promise.resolve();
    expect(
      await aggregateErrorMessages(
        evaluateStaticMutants(
          plan(mutants.slice(0, 3)),
          [
            passingGate(() =>
              ++gateCalls === 1
                ? Promise.reject(new Error("worker failed"))
                : Promise.resolve(0),
            ),
          ],
          config(),
          work.deps,
        ),
      ),
    ).toEqual(["Error: worker failed", "Error: cleanup failed"]);
  });

  test("cleans every copy after cancellation", async () => {
    const work = fakeWorkspace();
    const controller = new AbortController();
    const results = await evaluateStaticMutants(
      plan(mutants.slice(0, 3)),
      [
        passingGate(() => {
          controller.abort();
          return Promise.reject(new DOMException("Stopped", "AbortError"));
        }),
      ],
      config({ abortSignal: controller.signal }),
      work.deps,
    );
    expect(results.map(({ status }) => status)).toEqual([
      "timed-out",
      "timed-out",
      "timed-out",
    ]);
    expect(work.removed).toEqual(work.copied);
  });
});
