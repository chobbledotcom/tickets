#!/usr/bin/env -S deno run --allow-read

import { relative } from "node:path";
import {
  auditTestContent,
  type TestQualityFinding,
} from "./test-quality-audit-model.ts";
import { collectFiles } from "./walk-files.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.tsx?$/;
const auditFile = async (path: string): Promise<TestQualityFinding[]> => {
  const content = await Deno.readTextFile(path);
  return auditTestContent(path, content);
};

const testFiles = (): Promise<string[]> =>
  collectFiles("test", (path) => TEST_FILE_PATTERN.test(path));

const formatFinding = (finding: TestQualityFinding): string =>
  `${relative(
    Deno.cwd(),
    finding.path,
  )}:${finding.line}:${finding.column} ${finding.message}`;

if (import.meta.main) {
  const findings = (
    await Promise.all((await testFiles()).map(auditFile))
  ).flat();
  if (findings.length === 0) {
    console.log("Test quality audit found no weak assertion patterns.");
  } else {
    console.log(`Test quality audit found ${findings.length} review targets:`);
    for (const finding of findings) console.log(formatFinding(finding));
  }
}
