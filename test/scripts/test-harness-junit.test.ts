import { expect } from "@std/expect";
import { junitPathForRun } from "#scripts/test-harness.ts";

Deno.test("junitPathForRun keeps the caller's path", async () => {
  expect(await junitPathForRun("reports/durations.xml")).toBe(
    "reports/durations.xml",
  );
});

Deno.test("junitPathForRun answers a fresh temporary report path", async () => {
  const path = await junitPathForRun(undefined);

  expect(path.endsWith("junit.xml")).toBe(true);
  const dir = path.slice(0, path.lastIndexOf("/"));
  const stat = await Deno.stat(dir);
  expect(stat.isDirectory).toBe(true);
});
