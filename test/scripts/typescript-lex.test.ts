import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { blankSpans, lexicalSpans } from "#scripts/typescript-lex.ts";

const spans = (source: string) =>
  [...lexicalSpans(source)].map((span) => ({
    kind: span.kind,
    text: source.slice(span.start, span.end),
  }));

describe("lexicalSpans", () => {
  test("yields nothing for plain executable code", () => {
    expect(spans("const a = 1;")).toEqual([]);
  });

  test("yields a line comment and where it ends", () => {
    expect(spans("const a = 1; // note\n")).toEqual([
      { kind: "comment", text: "// note" },
    ]);
  });

  test("yields a block comment across lines", () => {
    expect(spans("/* a\nb */")).toEqual([
      { kind: "comment", text: "/* a\nb */" },
    ]);
  });

  test("yields strings as strings, not comments", () => {
    expect(spans('const a = "x";')).toEqual([{ kind: "string", text: '"x"' }]);
  });

  test("does not read a comment marker inside a string as a comment", () => {
    expect(spans('const u = "http://x/y";')).toEqual([
      { kind: "string", text: '"http://x/y"' },
    ]);
  });

  test("does not read a quote inside a comment as a string", () => {
    expect(spans("// it's fine\n")).toEqual([
      { kind: "comment", text: "// it's fine" },
    ]);
  });

  test("walks into a template substitution", () => {
    // Built as a template literal with an escaped `$`, so the fixture carries a
    // substitution as data without this file interpolating one.
    const literal = `\`x\${"y"}z\``;
    expect(spans(`const a = ${literal};`)).toEqual([
      { kind: "string", text: literal },
    ]);
  });

  test("yields spans in source order", () => {
    expect(spans('// a\nconst b = "c"; /* d */')).toEqual([
      { kind: "comment", text: "// a" },
      { kind: "string", text: '"c"' },
      { kind: "comment", text: "/* d */" },
    ]);
  });

  test("gives offsets that slice the original text back out", () => {
    const source = 'const a = "x"; // y';
    for (const span of lexicalSpans(source)) {
      expect(source.slice(span.start, span.end)).toBeTruthy();
      expect(span.end).toBeGreaterThan(span.start);
    }
  });
});

describe("lexicalSpans over regular expressions", () => {
  test("does not read a quote inside a regex as opening a string", () => {
    expect(spans('const m = svg.match(/viewBox="([^"]+)"/);')).toEqual([]);
  });

  test("stays in step after a regex, so a later URL is still a string", () => {
    // The exact shape that used to desync the walk: a regex holding quotes,
    // then a template literal whose `//` was reported as a comment.
    const source = [
      'const m = s.match(/viewBox="([^"]+)"/);',
      'const svg = `<svg xmlns="http://www.w3.org/2000/svg">`;',
    ].join("\n");
    expect(spans(source)).toEqual([
      { kind: "string", text: '`<svg xmlns="http://www.w3.org/2000/svg">`' },
    ]);
  });

  test("treats a slash after a value as division, not a regex", () => {
    expect(spans('const half = width / 2; const s = "x";')).toEqual([
      { kind: "string", text: '"x"' },
    ]);
  });

  test("treats a slash after a keyword as a regex", () => {
    expect(spans('const f = () => { return /a"b/.test(x); };')).toEqual([]);
  });

  test("keeps a slash inside a character class from ending the regex", () => {
    expect(spans('const r = /[/"]+/; const s = "after";')).toEqual([
      { kind: "string", text: '"after"' },
    ]);
  });

  test("keeps an escaped slash from ending the regex", () => {
    expect(spans('const r = /a\\/"b/; const s = "after";')).toEqual([
      { kind: "string", text: '"after"' },
    ]);
  });

  test("consumes trailing flags so they are not read as code", () => {
    expect(spans('const r = /a"b/gi; const s = "after";')).toEqual([
      { kind: "string", text: '"after"' },
    ]);
  });

  test("still finds a comment that follows a regex", () => {
    expect(spans('const r = /"/; // note\n')).toEqual([
      { kind: "comment", text: "// note" },
    ]);
  });

  test("does not mistake a division for a regex that swallows the line", () => {
    const source = 'const a = b / c; const d = "kept";';
    expect(spans(source)).toEqual([{ kind: "string", text: '"kept"' }]);
  });
});

describe("blankSpans over lexicalSpans", () => {
  test("blanks comments and keeps strings when asked", () => {
    expect(blankSpans('a = "b"; // c', false)).toBe('a = "b";     ');
  });

  test("blanks strings too when asked", () => {
    expect(blankSpans('a = "b"; // c', true)).toBe("a =    ;     ");
  });

  test("keeps newlines so offsets and line numbers survive", () => {
    expect(blankSpans("/* a\nb */\nc", false)).toBe("    \n    \nc");
  });
});
