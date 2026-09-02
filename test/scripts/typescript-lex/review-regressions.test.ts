import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bodyFingerprint } from "#scripts/check-shapes/rules.ts";
import {
  commentSpans,
  lexicalSpans,
  shapeOf,
} from "#scripts/typescript-lex.ts";
import { interpolated, template } from "#test/scripts/check-shapes/samples.ts";

describe("shape scanner review regressions", () => {
  test("skips a line comment before a for-await header", () => {
    const source = template(
      interpolated(
        " (rows) => { for await // note\n(const row of rows) /}/.test(row); finish(); } ",
      ),
    );

    expect(shapeOf(source)).toEqual([
      "STR",
      "(",
      "ID",
      ")",
      "=>",
      "{",
      "for",
      "await",
      "(",
      "const",
      "ID",
      "of",
      "ID",
      ")",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
      ";",
      "ID",
      "(",
      ")",
      ";",
      "}",
    ]);
  });

  test("still divides an awaited value after a line comment", () => {
    expect(shapeOf("await // note\n(total) / 2")).toEqual([
      "await",
      "(",
      "ID",
      ")",
      "/",
      "NUM",
    ]);
  });

  test("ignores a backtick in a line comment when it fingerprints code", () => {
    const shallow = "one(); // `\nif (ready) {\n  two();\n}";
    const deep = "    one(); // `\n    if (ready) {\n      two();\n    }";

    expect(bodyFingerprint(shallow)).toBe(bodyFingerprint(deep));
  });

  test("keeps a regex class inside a template interpolation", () => {
    const value = template(interpolated("/[/*]/.test(value)"));
    const shallow = `const found = ${value};\nafter();`;
    const deep = `    const found = ${value};\n    after();`;

    expect(bodyFingerprint(shallow)).toBe(bodyFingerprint(deep));
  });

  test("still keeps real template whitespace in a fingerprint", () => {
    expect(bodyFingerprint("return `a\n b`")).not.toBe(
      bodyFingerprint("return `a\nb`"),
    );
  });

  test("ends a template after JSX closing tags", () => {
    const templateSource = template(
      "x",
      interpolated("<div><span /></div>"),
      "y",
    );
    const source = `const text = ${templateSource}; tracked(1);`;
    const [templateSpan] = [...lexicalSpans(source)];

    expect(source.slice(templateSpan?.start, templateSpan?.end)).toBe(
      templateSource,
    );
  });

  test("keeps a pattern after a comparison operator", () => {
    expect(shapeOf("value < /name>/.test(text)")).toEqual([
      "ID",
      "<",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
    expect(shapeOf("value</name>/.test(text)")).toEqual([
      "ID",
      "<",
      "RE",
      ".",
      "ID",
      "(",
      "ID",
      ")",
    ]);
  });

  test("reads division after valid identifier forms", () => {
    expect(shapeOf("row.type / 2")).toEqual(["ID", ".", "ID", "/", "NUM"]);
    expect(shapeOf("café / 2")).toEqual(["ID", "/", "NUM"]);
    expect(shapeOf("runner.for(value) / 2")).toEqual([
      "ID",
      ".",
      "ID",
      "(",
      "ID",
      ")",
      "/",
      "NUM",
    ]);
    for (const word of ["async", "from", "type"]) {
      const withNote = `const half = ${word} / 2; // note`;
      expect(shapeOf(`const ${word} = 4; ${word} / 2`)).toEqual([
        "const",
        word,
        "=",
        "NUM",
        ";",
        word,
        "/",
        "NUM",
      ]);
      expect([...commentSpans(withNote)]).toEqual([
        {
          end: withNote.length,
          kind: "comment",
          start: withNote.indexOf("//"),
        },
      ]);
    }
    const astral = "const half = 𝒳 / 2; // note";
    expect(shapeOf("𝒳 / 2")).toEqual(["ID", "/", "NUM"]);
    expect([...commentSpans(astral)]).toEqual([
      { end: astral.length, kind: "comment", start: astral.indexOf("//") },
    ]);
  });
});
