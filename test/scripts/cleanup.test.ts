import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  failAfterCleanups,
  releaseWhenStarted,
  removeIfPresent,
  runCleanups,
  withCleanup,
} from "#scripts/cleanup.ts";

const failingCleanup =
  (calls: string[], name: string, error: unknown) => () => {
    calls.push(name);
    throw error;
  };

describe("script cleanup", () => {
  test("runs cleanup tasks in order after a successful task", async () => {
    const calls: string[] = [];

    const result = await withCleanup(() => {
      calls.push("task");
      return Promise.resolve(42);
    }, [
      () => {
        calls.push("stripe");
      },
      () => {
        calls.push("state");
      },
      () => {
        calls.push("assets");
      },
    ]);

    expect(result).toBe(42);
    expect(calls).toEqual(["task", "stripe", "state", "assets"]);
  });

  test("attempts every cleanup and aggregates their errors", async () => {
    const calls: string[] = [];
    const stripeError = new Error("stripe stop failed");
    const assetError = new Error("asset removal failed");

    const error = await runCleanups([
      failingCleanup(calls, "stripe", stripeError),
      () => {
        calls.push("state");
      },
      failingCleanup(calls, "assets", assetError),
    ]).catch((error) => error);

    expect(calls).toEqual(["stripe", "state", "assets"]);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([stripeError, assetError]);
  });

  test("preserves the task error together with cleanup errors", async () => {
    const taskError = new Error("tests failed");
    const stripeError = new Error("stripe stop failed");
    const stateError = new Error("state cleanup failed");

    const error = await withCleanup(
      () => Promise.reject(taskError),
      [() => Promise.reject(stripeError), () => Promise.reject(stateError)],
    ).catch((error) => error);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      taskError,
      stripeError,
      stateError,
    ]);
  });

  test("rethrows one task error unchanged after cleanup", async () => {
    const taskError = new Error("tests failed");
    let cleaned = false;

    const error = await withCleanup(
      () => Promise.reject(taskError),
      [
        () => {
          cleaned = true;
        },
      ],
    ).catch((error) => error);

    expect(cleaned).toBe(true);
    expect(error).toBe(taskError);
  });

  test("rethrows one cleanup AggregateError unchanged", async () => {
    const cleanupError = new AggregateError(
      [new Error("dispose failed"), new Error("remove failed")],
      "asset cleanup failed",
    );

    const error = await withCleanup(
      () => Promise.resolve("finished"),
      [() => Promise.reject(cleanupError)],
    ).catch((error) => error);

    expect(error).toBe(cleanupError);
  });

  test("accepts a generated file that is already gone", async () => {
    await expect(
      removeIfPresent("generated.js", () =>
        Promise.reject(new Deno.errors.NotFound("already removed")),
      ),
    ).resolves.toBeUndefined();
  });

  test("surfaces generated file removal failures", async () => {
    const removeError = new Deno.errors.PermissionDenied("cannot remove");

    await expect(
      removeIfPresent("generated.js", () => Promise.reject(removeError)),
    ).rejects.toBe(removeError);
  });

  test("preserves setup and rollback failures", async () => {
    const setupError = new Error("setup failed");
    const rollbackError = new Error("rollback failed");
    const result = failAfterCleanups(setupError, [
      () => Promise.reject(rollbackError),
    ]).catch((error) => error);

    const error = await result;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      setupError,
      rollbackError,
    ]);
  });

  test("uses Deno remove by default", async () => {
    const paths: Array<string | URL> = [];
    using _remove = stub(Deno, "remove", (path) => {
      paths.push(path);
      return Promise.resolve();
    });

    await removeIfPresent("generated.js");

    expect(paths).toEqual(["generated.js"]);
  });
});

describe("releaseWhenStarted", () => {
  /** A resource that takes a moment to arrive, like a spawned mock server. */
  const arrivesLater = <T>(value: T): Promise<T> =>
    new Promise((resolve) => setTimeout(() => resolve(value), 5));

  test("releases a resource that only finished starting after the failure", async () => {
    const stopped: string[] = [];
    const starting = arrivesLater("mock");
    const cleanup = releaseWhenStarted(starting, (started) => {
      stopped.push(started);
    });

    // The work fails immediately — long before the resource is up. This is the
    // case a "did it finish yet" check gets wrong, leaving the process behind.
    await expect(
      withCleanup(() => Promise.reject(new Error("setup failed")), [cleanup]),
    ).rejects.toThrow("setup failed");

    expect(stopped).toEqual(["mock"]);
  });

  test("releases a resource that had already started", async () => {
    const stopped: string[] = [];
    const cleanup = releaseWhenStarted(Promise.resolve("mock"), (started) => {
      stopped.push(started);
    });

    await withCleanup(() => Promise.resolve("done"), [cleanup]);

    expect(stopped).toEqual(["mock"]);
  });

  test("releases nothing when the resource never started", async () => {
    let released = 0;
    const cleanup = releaseWhenStarted(
      Promise.reject(new Error("could not start")),
      () => {
        released += 1;
      },
    );

    await expect(
      withCleanup(() => Promise.resolve("done"), [cleanup]),
    ).rejects.toThrow("could not start");

    expect(released).toBe(0);
  });

  test("reports a failed start alongside the failure that came first", async () => {
    const cleanup = releaseWhenStarted(
      Promise.reject(new Error("could not start")),
      () => {},
    );

    // Both went wrong at once. Neither may be dropped: the setup failure says
    // what stopped the run, the start failure says why the resource is missing.
    const error = await withCleanup(
      () => Promise.reject(new Error("setup failed")),
      [cleanup],
    ).catch((thrown: unknown) => thrown as AggregateError);

    expect(error.errors.map((each: Error) => each.message)).toEqual([
      "setup failed",
      "could not start",
    ]);
  });

  test("surfaces a failure to release the resource", async () => {
    const cleanup = releaseWhenStarted(arrivesLater("mock"), () => {
      throw new Error("could not stop the mock");
    });

    await expect(
      withCleanup(() => Promise.resolve("done"), [cleanup]),
    ).rejects.toThrow("could not stop the mock");
  });
});
