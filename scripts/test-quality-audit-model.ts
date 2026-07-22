import { lineColumnAt } from "./line-column.ts";
import { blankSpans, skipCommentOrString } from "./typescript-lex.ts";

export type TestQualityFinding = {
  column: number;
  line: number;
  message: string;
  path: string;
};

// Count bare `expect(`/`assert*(` as well as project assertion helpers that
// wrap them, otherwise tests that only assert through helpers look empty.
const EXPECT_PATTERN = /\bexpect\w*\s*\(|\bassert\w*\s*\(/;
const WEAK_ASSERTION_PATTERNS: { message: string; pattern: RegExp }[] = [
  {
    message:
      "presence-only assertion; prefer checking the value, shape, or invariant",
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

const testBlockEnd = (content: string, start: number): number | null => {
  let depth = 0;
  let seenOpen = false;
  for (let index = start; index < content.length; index += 1) {
    const skipped = skipCommentOrString(content, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    const char = content[index];
    if (char === "(") {
      depth += 1;
      seenOpen = true;
    }
    if (char === ")") depth -= 1;
    if (seenOpen && depth === 0) return index + 1;
  }
  return null;
};

const testBlockRanges = (content: string): { end: number; start: number }[] => {
  const ranges: { end: number; start: number }[] = [];
  // Match test declarations, but not predicate calls such as regex.test(value).
  const startPattern = /\bDeno\.test\s*\(|(?<![.\w$])(?:test|it)\s*\(/g;
  const code = blankSpans(content, true);
  let match = startPattern.exec(code);
  while (match !== null) {
    const start = match.index;
    const end = testBlockEnd(content, start);
    if (end !== null) ranges.push({ end, start });
    match = startPattern.exec(code);
  }
  return ranges;
};

const findAssertionlessTests = (
  path: string,
  content: string,
): TestQualityFinding[] =>
  testBlockRanges(content)
    .filter(({ end, start }) => !EXPECT_PATTERN.test(content.slice(start, end)))
    .map(({ start }) => ({
      ...lineColumnAt(content, start),
      message: "test has no visible assertion",
      path,
    }));

const findWeakAssertions = (
  path: string,
  content: string,
): TestQualityFinding[] => {
  const findings: TestQualityFinding[] = [];
  const code = blankSpans(content, true);
  for (const { message, pattern } of WEAK_ASSERTION_PATTERNS) {
    let match = pattern.exec(code);
    while (match !== null) {
      findings.push({
        ...lineColumnAt(content, match.index),
        message,
        path,
      });
      match = pattern.exec(code);
    }
  }
  return findings;
};

export const auditTestContent = (
  path: string,
  content: string,
): TestQualityFinding[] => [
  ...findAssertionlessTests(path, content),
  ...findWeakAssertions(path, content),
];
