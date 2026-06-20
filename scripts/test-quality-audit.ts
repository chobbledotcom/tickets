#!/usr/bin/env -S deno run --allow-read

import { relative } from "node:path";

type Finding = {
  column: number;
  line: number;
  message: string;
  path: string;
};

const TEST_FILE_PATTERN = /\.(?:test|spec)\.tsx?$/;
// Count bare `expect(`/`assert*(` as well as project assertion helpers that
// wrap them (e.g. `expectHtmlResponse(...)`, `expectRedirectWithFlash(...)`),
// otherwise tests that only assert through those helpers look assertionless.
const EXPECT_PATTERN = /\bexpect\w*\s*\(|\bassert\w*\s*\(/;
const WEAK_ASSERTION_PATTERNS: { message: string; pattern: RegExp }[] = [
  {
    message:
      "presence-only assertion; prefer checking the value, shape, or invariant",
    // `[^;]+?` (lazy) lets the call span multiple lines while staying within a
    // single statement, so wrapped `expect(...)` calls are still matched.
    pattern: /expect\s*\([^;]+?\)\s*\.\s*toBe(?:Defined|Undefined)\s*\(/g,
  },
  {
    message:
      "truthiness assertion; prefer an exact value or contract-specific matcher",
    pattern: /expect\s*\([^;]+?\)\s*\.\s*toBe(?:Truthy|Falsy)\s*\(/g,
  },
  {
    message:
      "compound boolean assertion; split into contract-specific assertions",
    pattern:
      /expect\s*\([^)]*(?:&&|\|\||===|!==|>=|<=|>|<)[^)]*\)\s*\.\s*toBe\s*\(\s*(?:true|false)\s*\)/g,
  },
];

const lineColumnAt = (content: string, index: number) => {
  const before = content.slice(0, index);
  const lines = before.split("\n");
  return { column: lines.at(-1)!.length + 1, line: lines.length };
};

const testBlockRanges = (content: string): { end: number; start: number }[] => {
  const ranges: { end: number; start: number }[] = [];
  // Match `test(`/`it(` declarations and `Deno.test(`, but not predicate method
  // calls such as `someRegex.test(value)` (the lookbehind rejects a leading
  // `.`/identifier char) which would otherwise be flagged as assertionless.
  const startPattern = /\bDeno\.test\s*\(|(?<![.\w$])(?:test|it)\s*\(/g;
  for (const match of content.matchAll(startPattern)) {
    const start = match.index ?? 0;
    let depth = 0;
    let seenOpen = false;
    for (let index = start; index < content.length; index += 1) {
      const char = content[index];
      if (char === "(") {
        depth += 1;
        seenOpen = true;
      }
      if (char === ")") depth -= 1;
      if (seenOpen && depth === 0) {
        ranges.push({ end: index + 1, start });
        break;
      }
    }
  }
  return ranges;
};

const findAssertionlessTests = (path: string, content: string): Finding[] =>
  testBlockRanges(content)
    .filter(({ end, start }) => !EXPECT_PATTERN.test(content.slice(start, end)))
    .map(({ start }) => ({
      ...lineColumnAt(content, start),
      message: "test has no visible assertion",
      path,
    }));

const findWeakAssertions = (path: string, content: string): Finding[] => {
  const findings: Finding[] = [];
  for (const { message, pattern } of WEAK_ASSERTION_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      findings.push({
        ...lineColumnAt(content, match.index ?? 0),
        message,
        path,
      });
    }
  }
  return findings;
};

const auditFile = async (path: string): Promise<Finding[]> => {
  const content = await Deno.readTextFile(path);
  return [
    ...findAssertionlessTests(path, content),
    ...findWeakAssertions(path, content),
  ];
};

const collectTestFiles = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...(await collectTestFiles(path)));
      continue;
    }
    if (entry.isFile && TEST_FILE_PATTERN.test(path)) files.push(path);
  }
  return files;
};

const testFiles = async (): Promise<string[]> =>
  (await collectTestFiles("test")).sort();

const formatFinding = (finding: Finding): string =>
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
