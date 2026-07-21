import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  extractCallSites,
  isConstantLiteral,
  parseArgList,
  skipComment,
  skipString,
} from "./detectors.ts";

/**
 * Tests for the call-site scanner and its supporting tokenizer helpers
 * (`skipString`/`skipComment`/`parseArgList`). Split out of `detectors.test.ts`
 * so each file stays under Biome's 1,000-line ceiling.
 */

describe("isConstantLiteral", () => {
  const cases: [string, boolean][] = [
    ['"str"', true],
    ["'str'", true],
    ["`tpl`", true],
    ["123", true],
    ["-5", true],
    ["0", true],
    ["true", true],
    ["false", true],
    ["null", true],
    ["undefined", true],
    ["variable", false],
    ["build()", false],
    ["a + b", false],
  ];
  for (const [arg, expected] of cases) {
    test(`${arg} -> ${expected}`, () => {
      expect(isConstantLiteral(arg)).toBe(expected);
    });
  }
});

describe("extractCallSites", () => {
  const cases: {
    name: string;
    src: string;
    expected: ReturnType<typeof extractCallSites>;
  }[] = [
    {
      expected: [{ args: ["1", "2"], line: 1, name: "foo" }],
      name: "a simple call with two arguments",
      src: "foo(1, 2)",
    },
    {
      expected: [{ args: ['"a, b"', "c"], line: 1, name: "foo" }],
      name: "a comma inside a double-quoted string (not an arg separator)",
      src: 'foo("a, b", c)',
    },
    {
      expected: [{ args: ["'x'", "`y`"], line: 1, name: "foo" }],
      name: "single-quoted and template-literal arguments",
      src: "foo('x', `y`)",
    },
    {
      expected: [{ args: ['"a\\"b"'], line: 1, name: "foo" }],
      name: "an escaped quote inside a string",
      src: 'foo("a\\"b")',
    },
    {
      expected: [{ args: ['"a$b"'], line: 1, name: "foo" }],
      name: "a double-quoted string containing a lone $",
      src: 'foo("a$b")',
    },
    {
      expected: [
        { args: ["bar(1, 2)", "[3, 4]", "{a: 5}"], line: 1, name: "foo" },
        { args: ["1", "2"], line: 1, name: "bar" },
      ],
      // The nested `bar(...)` call is also discovered; foo's own arguments keep
      // their nested commas because brackets bump the depth past the top level.
      name: "nested calls, arrays and objects (depth tracking)",
      src: "foo(bar(1, 2), [3, 4], {a: 5})",
    },
    {
      expected: [{ args: ["1"], line: 1, name: "foo" }],
      name: "a keyword followed by a paren is not a call",
      src: "if (cond) foo(1)",
    },
    {
      expected: [{ args: ["a"], line: 1, name: "bar" }],
      name: "a function declaration name is not a call",
      src: "function foo(a) { bar(a); }",
    },
    {
      expected: [{ args: ["1"], line: 1, name: "bar" }],
      name: "an identifier not followed by a paren is not a call",
      src: "const x = foo; bar(1)",
    },
    {
      expected: [{ args: [], line: 1, name: "foo" }],
      name: "whitespace between the name and the paren",
      src: "foo ()",
    },
    {
      expected: [{ args: [], line: 1, name: "foo" }],
      name: "an empty argument list",
      src: "foo()",
    },
    {
      expected: [{ args: ["a"], line: 1, name: "foo" }],
      name: "a trailing empty argument is dropped",
      src: "foo(a, )",
    },
    {
      expected: [{ args: ["2"], line: 2, name: "bar" }],
      name: "a line comment hides a call; line numbers are resolved",
      src: "// foo(1)\nbar(2)",
    },
    {
      expected: [{ args: ["2"], line: 1, name: "bar" }],
      name: "a block comment hides a call",
      src: "/* foo(1) */ bar(2)",
    },
    {
      expected: [{ args: ["x /* , */", "y"], line: 1, name: "foo" }],
      // A comma inside a comment must not split the argument list: the comment
      // text stays in the arg slice, but there are still exactly two arguments.
      name: "a comma inside a comment does not split arguments",
      src: "foo(x /* , */, y)",
    },
    {
      expected: [
        { args: ["1"], line: 2, name: "foo" },
        { args: ["2"], line: 4, name: "bar" },
      ],
      name: "two calls on different lines",
      src: "\nfoo(1)\n\nbar(2)",
    },
    {
      expected: [{ args: [], line: 1, name: "foo" }],
      name: "an unterminated string stops cleanly",
      src: 'foo("abc',
    },
    {
      expected: [{ args: [], line: 1, name: "foo" }],
      name: "an unterminated argument list stops cleanly",
      src: "foo(a",
    },
    {
      expected: [],
      name: "an unterminated line comment yields no calls",
      src: "// foo(1)",
    },
    {
      expected: [],
      name: "an unterminated block comment yields no calls",
      src: "/* foo(1)",
    },
    {
      expected: [{ args: ['"bar()"'], line: 1, name: "foo" }],
      // A call-like sequence inside a double-quoted string must stay hidden.
      name: "a call inside a double-quoted string is not detected",
      src: 'foo("bar()")',
    },
    {
      expected: [{ args: ["'baz()'"], line: 1, name: "foo" }],
      name: "a call inside a single-quoted string is not detected",
      src: "foo('baz()')",
    },
    {
      expected: [{ args: ["`qux()`"], line: 1, name: "foo" }],
      name: "a call inside a template literal is not detected",
      src: "foo(`qux()`)",
    },
    {
      expected: [{ args: ["1"], line: 1, name: "foo" }],
      // Scanning must resume *at* the end of a comment, not be advanced past it:
      // an off-by addition here would land mid-token and miss the real call.
      name: "scanning resumes exactly after a mid-line comment",
      src: "ab /* c */ foo(1)",
    },
    {
      expected: [{ args: ["1"], line: 1, name: "foo" }],
      name: "scanning resumes exactly after a mid-line string",
      src: "ab 'xxxx' foo(1)",
    },
    {
      expected: [{ args: [], line: 1, name: "foo" }],
      // The "function" guard must be cleared after a string, or the following
      // call would be wrongly treated as a function declaration name.
      name: "a string clears the preceding-word guard",
      src: 'function "s" foo()',
    },
    {
      expected: [],
      // The preceding word is replaced, not accumulated: with replacement the
      // most recent word is "function", which suppresses this call (no calls).
      // Under an accumulating mutant the guard reads "afunction" and the call
      // would wrongly be reported.
      name: "the preceding-word guard is replaced, not accumulated",
      src: "a function foo()",
    },
    {
      expected: [{ args: [], line: 1, name: "foo" }],
      // A punctuation token clears the guard: `function;` does not suppress the
      // following call the way `function foo()` would.
      name: "punctuation clears the preceding-word guard",
      src: "function; foo()",
    },
  ];
  for (const { name, src, expected } of cases) {
    test(name, () => {
      expect(extractCallSites(src)).toEqual(expected);
    });
  }

  test("skips template substitutions: nested braces, strings and templates", () => {
    // Source text:  foo(`a$b${ {x:"q"} }${'s'}${`t`}`)
    // The whole backtick template is one argument; the `bar` call and comma-like
    // characters inside `${...}` must NOT leak out as separate calls/args.
    const template = "`a$b${ {x:\"q\"} }${'s'}${`t`}`";
    const src = `foo(${template})`;
    expect(extractCallSites(src)).toEqual([
      { args: [template], line: 1, name: "foo" },
    ]);
  });

  test("handles an unterminated template substitution", () => {
    // Source text:  foo(`${x`)   — the inner backtick opens a nested template
    // that never closes, so the whole thing is consumed as one (empty) call.
    const src = "foo(`${x`)";
    expect(extractCallSites(src)).toEqual([{ args: [], line: 1, name: "foo" }]);
  });
});

/**
 * Direct tokenizer tests. `extractCallSites` is too forgiving to expose these
 * helpers' internal edge cases — it always recovers at the next closing quote —
 * so the index/argument contracts are asserted here. (Same rationale as the
 * codebase's other "internal parser exposed for unit testing only".)
 */
describe("skipString", () => {
  test("returns the index just past a simple string", () => {
    expect(skipString('"abc"', 0)).toBe(5);
  });

  test("skips an escaped character rather than closing on it", () => {
    // The backslash escapes the next char; without skipping two, the closing
    // quote would be misread (and the index would be wrong).
    expect(skipString('"a\\nb"', 0)).toBe(6);
  });

  test("skips a template substitution", () => {
    expect(skipString("`${x}`", 0)).toBe(6);
  });

  test("ends a template at its closing backtick, leaving trailing code", () => {
    // Stops just past the closing backtick (index 6) rather than treating the
    // substitution's contents as nested strings and running into `bar`.
    expect(skipString("`${a}`bar", 0)).toBe(6);
  });

  test("tracks brace depth inside a substitution", () => {
    // The inner `{ ... }` must raise the depth so the substitution ends at the
    // outer `}`, not the inner one (which would expose the inner backtick).
    expect(skipString("`${ { `x` } }`", 0)).toBe(14);
  });

  test("skips a double-quoted nested string inside a substitution", () => {
    expect(skipString('`${ "}" + `x` }`', 0)).toBe(16);
  });

  test("skips a single-quoted nested string inside a substitution", () => {
    expect(skipString("`${ '}' }`", 0)).toBe(10);
  });

  test("skips a backtick nested string inside a substitution", () => {
    expect(skipString("`${ `}` }`", 0)).toBe(10);
  });

  test("treats a lone $ in a template as literal", () => {
    expect(skipString("`a$b`", 0)).toBe(5);
  });

  test("treats $ in a non-template string as literal", () => {
    expect(skipString('"a$b"', 0)).toBe(5);
  });

  test("returns past the end for an unterminated string", () => {
    expect(skipString('"abc', 0)).toBe(4);
  });
});

describe("skipComment", () => {
  test("skips a line comment up to the newline", () => {
    expect(skipComment("// x\ny", 0)).toBe(4);
  });

  test("skips a line comment running to end of input", () => {
    expect(skipComment("// x", 0)).toBe(4);
  });

  test("skips a block comment", () => {
    expect(skipComment("/* x */y", 0)).toBe(7);
  });

  test("ends a block comment only at star-slash, not a bare slash", () => {
    expect(skipComment("/* a/ */", 0)).toBe(8);
  });

  test("does not treat a lone slash as the start of a comment", () => {
    expect(skipComment("/x", 0)).toBe(0);
  });

  test("returns the index unchanged for a non-comment slash", () => {
    expect(skipComment("x/y", 1)).toBe(1);
  });
});

describe("parseArgList", () => {
  test("splits top-level comma-separated arguments", () => {
    expect(parseArgList("(a, b)", 0).args).toEqual(["a", "b"]);
  });

  test("does not split on a comma inside a single-quoted string", () => {
    expect(parseArgList("('a,b')", 0).args).toEqual(["'a,b'"]);
  });

  test("does not split on a comma inside a double-quoted string", () => {
    expect(parseArgList('("a,b")', 0).args).toEqual(['"a,b"']);
  });

  test("keeps nested-bracket contents as a single argument", () => {
    expect(parseArgList("(f(1, 2), [3])", 0).args).toEqual(["f(1, 2)", "[3]"]);
  });

  test("reports the closing-paren index as the end", () => {
    expect(parseArgList("(a)", 0).end).toBe(2);
  });

  test("drops an empty trailing argument", () => {
    expect(parseArgList("(a, )", 0).args).toEqual(["a"]);
  });

  test("stops cleanly on an unterminated list", () => {
    expect(parseArgList("(a", 0).args).toEqual([]);
  });
});
