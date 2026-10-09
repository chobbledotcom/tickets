import { expect } from "@std/expect";
import {
  junitPathInArgs,
  junitReportForRun,
} from "#scripts/junit-report-path.ts";

Deno.test("junitReportForRun keeps the caller's path and leaves the directory theirs", async () => {
  const report = await junitReportForRun("reports/durations.xml");

  expect(report).toEqual({ dir: undefined, path: "reports/durations.xml" });
});

Deno.test("junitReportForRun answers a fresh temporary report path", async () => {
  const report = await junitReportForRun(undefined);

  expect(report.path.endsWith("junit.xml")).toBe(true);
  const stat = await Deno.stat(report.dir ?? "");
  expect(stat.isDirectory).toBe(true);
});

Deno.test("junitPathInArgs finds a forwarded path after the flag", () => {
  expect(junitPathInArgs(["--parallel", "--junit-path", "r.xml"])).toBe(
    "r.xml",
  );
});

Deno.test("junitPathInArgs finds a forwarded path in equals form", () => {
  expect(junitPathInArgs(["--junit-path=r.xml"])).toBe("r.xml");
});

Deno.test("junitPathInArgs answers nothing when the arguments carry no report", () => {
  expect(junitPathInArgs(["--parallel", "-A"])).toBe(undefined);
});
