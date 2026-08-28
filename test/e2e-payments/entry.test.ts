/** Direct tests for the shared harness failure boundary. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { failRun, runHarness } from "#e2e/entry.ts";

/** Run one boundary call with the process exit status restored afterwards. */
const withExitCode = async (
  run: () => Promise<void>,
): Promise<number | undefined> => {
  const before = process.exitCode;
  try {
    await run();
    return typeof process.exitCode === "number" ? process.exitCode : undefined;
  } finally {
    process.exitCode = before;
  }
};

const loggedErrors = (errors: Stub): string =>
  errors.calls.map((call) => String(call.args[0])).join("\n");

describe("failRun", () => {
  test("reports the message, notifies, and sets the failure status", async () => {
    using errors = stub(console, "error");
    const notified = { count: 0 };
    const code = await withExitCode(() =>
      failRun("FAIL — resend: the provider said no", async () => {
        notified.count += 1;
      }),
    );
    expect(code).toBe(1);
    expect(notified.count).toBe(1);
    expect(loggedErrors(errors)).toContain(
      "FAIL — resend: the provider said no",
    );
  });

  test("still fails the run when the notifier itself rejects", async () => {
    using _errors = stub(console, "error");
    const code = await withExitCode(() =>
      failRun("FAIL — ntfy is down too", () =>
        Promise.reject(new Error("ntfy unreachable")),
      ),
    );
    expect(code).toBe(1);
  });
});

describe("runHarness", () => {
  test("leaves a passing main alone", async () => {
    using errors = stub(console, "error");
    const notified = { count: 0 };
    const code = await withExitCode(() =>
      runHarness(
        () => Promise.resolve(),
        async () => {
          notified.count += 1;
        },
      ),
    );
    expect(code).toBeUndefined();
    expect(notified.count).toBe(0);
    expect(errors.calls).toHaveLength(0);
  });

  test("reports a crash's stack and notifies", async () => {
    using errors = stub(console, "error");
    const notified = { count: 0 };
    const code = await withExitCode(() =>
      runHarness(
        () => Promise.reject(new Error("the tunnel never came up")),
        async () => {
          notified.count += 1;
        },
      ),
    );
    expect(code).toBe(1);
    expect(notified.count).toBe(1);
    expect(loggedErrors(errors)).toContain("the tunnel never came up");
    expect(loggedErrors(errors)).toContain("entry.test.ts");
  });

  test("falls back to the message when the error carries no stack", async () => {
    using errors = stub(console, "error");
    const bare = new Error("bare message");
    delete bare.stack;
    const code = await withExitCode(() =>
      runHarness(
        () => Promise.reject(bare),
        () => Promise.resolve(),
      ),
    );
    expect(code).toBe(1);
    expect(loggedErrors(errors)).toContain("bare message");
    expect(loggedErrors(errors)).not.toContain("entry.test.ts");
  });

  test("stringifies a crash that is not an Error", async () => {
    using errors = stub(console, "error");
    const code = await withExitCode(() =>
      runHarness(
        () => Promise.reject("a plain string failure"),
        () => Promise.resolve(),
      ),
    );
    expect(code).toBe(1);
    expect(loggedErrors(errors)).toContain("a plain string failure");
  });
});
