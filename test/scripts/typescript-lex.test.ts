import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  blankSpans,
  commentSpans,
  lexicalSpans,
} from "#scripts/typescript-lex.ts";

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

  test("keeps an escaped quote from ending the string", () => {
    expect(spans('const a = "x\\"y"; const b = \'after\';')).toEqual([
      { kind: "string", text: '"x\\"y"' },
      { kind: "string", text: "'after'" },
    ]);
  });

  test("a dollar sign inside a plain string opens nothing", () => {
    expect(spans('const s = "a$b"; const t = "after";')).toEqual([
      { kind: "string", text: '"a$b"' },
      { kind: "string", text: '"after"' },
    ]);
    expect(spans('const s = "a${b"; const t = "after";')).toEqual([
      { kind: "string", text: '"a${b"' },
      { kind: "string", text: '"after"' },
    ]);
  });

  test("a backtick quoted inside a substitution does not end the template", () => {
    const literal = `\`a\${"\`"}b\``;
    expect(spans(`const a = ${literal};`)).toEqual([
      { kind: "string", text: literal },
    ]);
  });

  test("nested braces and quoted braces inside a substitution", () => {
    const nested = `\`\${ {x} "\`" } end\``;
    const quoted = `\`\${ "}" "\`" } end\``;
    expect(spans(`const a = ${nested};`)).toEqual([
      { kind: "string", text: nested },
    ]);
    expect(spans(`const a = ${quoted};`)).toEqual([
      { kind: "string", text: quoted },
    ]);
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

  test("an apostrophe after a word is punctuation, not a string opener", () => {
    // TSX text shape: reading the apostrophe as a quote would swallow the
    // comment behind it into an unterminated string.
    expect(spans("const s = it's fine; // note")).toEqual([
      { kind: "comment", text: "// note" },
    ]);
  });

  test("yields an unterminated block comment to the text's end", () => {
    expect(spans("/* open forever")).toEqual([
      { kind: "comment", text: "/* open forever" },
    ]);
  });

  test("closes each of two far-apart block comments at its own end", () => {
    expect(spans("/*a*/ middle /*b*/ tail")).toEqual([
      { kind: "comment", text: "/*a*/" },
      { kind: "comment", text: "/*b*/" },
    ]);
  });

  test("reads a comment whose only closer overlaps its opener", () => {
    // `/*/` holds a `*/` from the second character on, and the scan must not
    // close on the opener's own characters.
    expect(spans("/*/ x")).toEqual([{ kind: "comment", text: "/*/ x" }]);
  });

  test("walks into a template substitution", () => {
    // Built as a template literal with an escaped `$`, so the fixture carries a
    // substitution as data without this file interpolating one.
    const literal = `\`x\${"y"}z\``;
    expect(spans(`const a = ${literal};`)).toEqual([
      { kind: "string", text: literal },
    ]);
  });

  test("a brace quoted inside a substitution does not close it", () => {
    // The substitution holds a string with a `}` of its own; counting it
    // would end the template one brace too early.
    const literal = `\`x\${o["}"]}y\``;
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
  test("yields the regex itself, not the quotes inside it", () => {
    expect(spans('const m = svg.match(/viewBox="([^"]+)"/);')).toEqual([
      { kind: "regex", text: '/viewBox="([^"]+)"/' },
    ]);
  });

  test("stays in step after a regex, so a later URL is still a string", () => {
    // The exact shape that used to desync the walk: a regex holding quotes,
    // then a template literal whose `//` was reported as a comment.
    const source = [
      'const m = s.match(/viewBox="([^"]+)"/);',
      'const svg = `<svg xmlns="http://www.w3.org/2000/svg">`;',
    ].join("\n");
    expect(spans(source)).toEqual([
      { kind: "regex", text: '/viewBox="([^"]+)"/' },
      { kind: "string", text: '`<svg xmlns="http://www.w3.org/2000/svg">`' },
    ]);
  });

  test("treats a slash after a value as division, not a regex", () => {
    expect(spans('const half = width / 2; const s = "x";')).toEqual([
      { kind: "string", text: '"x"' },
    ]);
  });

  test("treats a slash straight after postfix ++ or -- as division", () => {
    // The slash must sit directly behind the operator: anything between
    // them hides the postfix decision from the scan.
    const step = 'let y = 0; const half = y++ / 2; click("Gone");';
    const index = 'const a = items[0]++ / 2; const s = "kept";';
    const paren = 'const b = (x)-- / 2; const t = "also kept";';
    expect(spans(step)).toEqual([{ kind: "string", text: '"Gone"' }]);
    expect(spans(index)).toEqual([{ kind: "string", text: '"kept"' }]);
    expect(spans(paren)).toEqual([{ kind: "string", text: '"also kept"' }]);
  });

  test("still opens a regex after a single plus or a binary one", () => {
    const unary = 'const two = +/2"x"/.source; const s = "after";';
    const binary = 'const three = count + +/3"x"/.source; const t = "later";';
    const paren = 'const four = (x)+/4"x"/.source; const u = "last";';
    expect(spans(unary)).toEqual([
      { kind: "regex", text: '/2"x"/' },
      { kind: "string", text: '"after"' },
    ]);
    expect(spans(binary)).toEqual([
      { kind: "regex", text: '/3"x"/' },
      { kind: "string", text: '"later"' },
    ]);
    expect(spans(paren)).toEqual([
      { kind: "regex", text: '/4"x"/' },
      { kind: "string", text: '"last"' },
    ]);
  });

  test("opens a regex after every keyword that cannot end an expression", () => {
    // The list is a fact of the grammar, spelled out here so removing any
    // one word from the scan's set fails this test. Each keyword sits at
    // the very start of its source, so the word scan must read from
    // character zero.
    const keywords = [
      "await",
      "case",
      "delete",
      "do",
      "else",
      "in",
      "instanceof",
      "new",
      "of",
      "return",
      "typeof",
      "void",
      "yield",
    ];
    for (const keyword of keywords) {
      const source = `${keyword} /x"/.test(s); const t = "after";`;
      expect(spans(source)).toEqual([
        { kind: "regex", text: '/x"/' },
        { kind: "string", text: '"after"' },
      ]);
    }
  });

  test("treats a slash after a one-letter word at the very start as division", () => {
    expect(spans('x / 2; const s = "k";')).toEqual([
      { kind: "string", text: '"k"' },
    ]);
  });

  test("treats a slash after a keyword as a regex", () => {
    expect(spans('const f = () => { return /a"b/.test(x); };')).toEqual([
      { kind: "regex", text: '/a"b/' },
    ]);
  });

  test("keeps a slash inside a character class from ending the regex", () => {
    expect(spans('const r = /[/"]+/; const s = "after";')).toEqual([
      { kind: "regex", text: '/[/"]+/' },
      { kind: "string", text: '"after"' },
    ]);
  });

  test("keeps an escaped open-bracket from opening a character class", () => {
    expect(spans('const r = /a\\[/; const s = "after";')).toEqual([
      { kind: "regex", text: "/a\\[/" },
      { kind: "string", text: '"after"' },
    ]);
  });

  test("a class as the first body characters still holds its slash", () => {
    expect(spans('const r = /[/]/; const s = "after";')).toEqual([
      { kind: "regex", text: "/[/]/" },
      { kind: "string", text: '"after"' },
    ]);
    expect(spans('const r = /[a/]/; const s = "after";')).toEqual([
      { kind: "regex", text: "/[a/]/" },
      { kind: "string", text: '"after"' },
    ]);
  });

  test("a newline as the first body character means the slash divided", () => {
    expect(spans('const r = /\n/x/; const s = "after";')).toEqual([
      { kind: "string", text: '"after"' },
    ]);
  });

  test("keeps an escaped slash from ending the regex", () => {
    expect(spans('const r = /a\\/"b/; const s = "after";')).toEqual([
      { kind: "regex", text: '/a\\/"b/' },
      { kind: "string", text: '"after"' },
    ]);
  });

  test("consumes trailing flags so they are not read as code", () => {
    expect(spans('const r = /a"b/gi; const s = "after";')).toEqual([
      { kind: "regex", text: '/a"b/gi' },
      { kind: "string", text: '"after"' },
    ]);
  });

  test("still finds a comment that follows a regex", () => {
    expect(spans('const r = /"/; // note\n')).toEqual([
      { kind: "regex", text: '/"/' },
      { kind: "comment", text: "// note" },
    ]);
  });

  test("does not mistake a division for a regex that swallows the line", () => {
    const source = 'const a = b / c; const d = "kept";';
    expect(spans(source)).toEqual([{ kind: "string", text: '"kept"' }]);
  });

  test("reads a regex opening the very first character as a regex", () => {
    expect(spans('/"/.test(x); const s = "after";')).toEqual([
      { kind: "regex", text: '/"/' },
      { kind: "string", text: '"after"' },
    ]);
  });

  test("stops at the end of an unterminated regex rather than looping", () => {
    expect(spans('const r = /abc"')).toEqual([
      { kind: "regex", text: '/abc"' },
    ]);
  });

  test("a lone slash as the very last character reads as division", () => {
    expect(spans("const a = /")).toEqual([]);
  });

  test("stays in step across a string, a regex, then another string", () => {
    expect(spans('const a = "x"; const r = /y"/; const b = "z";')).toEqual([
      { kind: "string", text: '"x"' },
      { kind: "regex", text: '/y"/' },
      { kind: "string", text: '"z"' },
    ]);
  });

  test("looks past a comment to the code that decides the regex", () => {
    // The comment's last word is not a token: what precedes the regex here is
    // the `;`, so the `/` opens a regex and its quote never starts a string.
    expect(spans('const a = 1; // see x\n/a"b/.test(s)')).toEqual([
      { kind: "comment", text: "// see x" },
      { kind: "regex", text: '/a"b/' },
    ]);
  });

  test("looks past a comment that ends in spaces", () => {
    expect(spans('const a = 1; // see x   \n/a"b/.test(s)')).toEqual([
      { kind: "comment", text: "// see x   " },
      { kind: "regex", text: '/a"b/' },
    ]);
  });

  test("looks past a comment ended by a carriage return", () => {
    expect(spans('const a = 1; // see x\r\n/a"b/.test(s)')).toEqual([
      { kind: "comment", text: "// see x\r" },
      { kind: "regex", text: '/a"b/' },
    ]);
  });

  test("looks past a run of comments, not just the nearest", () => {
    expect(spans('// one\n// two\n/a"b/.test(s); const s = "after";')).toEqual([
      { kind: "comment", text: "// one" },
      { kind: "comment", text: "// two" },
      { kind: "regex", text: '/a"b/' },
      { kind: "string", text: '"after"' },
    ]);
  });

  test("treats a slash after a call result as division, not a regex", () => {
    expect(spans('const half = f() / 2; const s = "x";')).toEqual([
      { kind: "string", text: '"x"' },
    ]);
  });

  test("stops a candidate regex at a newline, so it was division", () => {
    expect(spans('x = (a) ? /b\nconst s = "after";')).toEqual([
      { kind: "string", text: '"after"' },
    ]);
  });

  test("stops a candidate regex at every ECMAScript line terminator", () => {
    // CR alone, the line separator, and the paragraph separator all end a
    // candidate body the way LF does: the slash divided.
    expect(spans('x = (a) ? /b\rconst s = "after";')).toEqual([
      { kind: "string", text: '"after"' },
    ]);
    expect(spans('x = (a) ? /b\u2028const s = "after";')).toEqual([
      { kind: "string", text: '"after"' },
    ]);
    expect(spans('x = (a) ? /b\u2029const s = "after";')).toEqual([
      { kind: "string", text: '"after"' },
    ]);
  });
});

describe("commentSpans", () => {
  test("yields the comments and leaves the strings out", () => {
    const source = '// a\nconst b = "c"; /* d */';
    expect(
      [...commentSpans(source)].map((span) =>
        source.slice(span.start, span.end),
      ),
    ).toEqual(["// a", "/* d */"]);
  });

  test("yields nothing for a file with no comments", () => {
    expect([...commentSpans('const a = "x";')]).toEqual([]);
  });

  test("still walks strings, so a marker inside one is not a comment", () => {
    expect([...commentSpans('const u = "http://x";')]).toEqual([]);
  });
});

describe("blankSpans over lexicalSpans", () => {
  test("blanks comments and keeps strings when asked", () => {
    expect(blankSpans('a = "b"; // c', false)).toBe('a = "b";     ');
  });

  test("blanks strings too when asked", () => {
    expect(blankSpans('a = "b"; // c', true)).toBe("a =    ;     ");
  });

  test("blanks a regex body like a comment, either way", () => {
    expect(blankSpans('a = /b"c/; // d', false)).toBe("a =      ;     ");
    expect(blankSpans('a = /b"c/; // d', true)).toBe("a =      ;     ");
  });

  test("keeps newlines so offsets and line numbers survive", () => {
    expect(blankSpans("/* a\nb */\nc", false)).toBe("    \n    \nc");
  });
});
