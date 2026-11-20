import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { denoExitCode } from "#scripts/mutation/child-process.ts";

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

test("a captured child in its own group returns its exit code", async () => {
  const code = await denoExitCode(["eval", "Deno.exit(0)"], {
    signal: new AbortController().signal,
  });

  expect(code).toBe(0);
});

test("a child started with an already aborted signal is killed at once", async () => {
  const code = await denoExitCode(["eval", "setTimeout(() => {}, 60_000)"], {
    signal: AbortSignal.abort(),
  });

  expect(code).not.toBe(0);
});

test("aborting a captured child kills its whole process group at once", async () => {
  const controller = new AbortController();
  const running = denoExitCode(
    [
      "eval",
      "--allow-all",
      [
        "const child = new Deno.Command(Deno.execPath(), {",
        '  args: ["eval", "--allow-all", "setTimeout(() => {}, 60_000)"],',
        "}).spawn();",
        "await child.status;",
      ].join("\n"),
    ],
    { signal: controller.signal },
  );
  controller.abort();

  expect(await running).not.toBe(0);
});
