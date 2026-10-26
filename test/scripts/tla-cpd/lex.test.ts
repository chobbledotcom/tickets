import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { tokenizeTla } from "#scripts/tla-cpd/lex.ts";
import { prepareSource } from "#scripts/tla-cpd/prepare.ts";

Deno.test("TLA comments nest and leave token boundaries intact", () => {
  const source =
    "left(* outer (* nested *) remaining *)right \\* ignored\nnext";
  assertEquals(
    tokenizeTla(source).map(({ text }) => text),
    ["left", "right", "next"],
  );
  assertEquals(
    tokenizeTla("left right next").map(({ text }) => text),
    ["left", "right", "next"],
  );
  assertNotEquals(
    prepareSource("a", "left right").encoded,
    prepareSource("a", "leftright").encoded,
  );
});

Deno.test("TLA strings retain comment markers, escapes and literal identity", () => {
  const source = String.raw`"(* not a comment *) \\* neither \"quoted\"" "different"`;
  const tokens = tokenizeTla(source);
  assertEquals(
    tokens.map(({ kind }) => kind),
    ["string", "string"],
  );
  assertEquals(
    tokens[0]?.text,
    String.raw`"(* not a comment *) \\* neither \"quoted\""`,
  );
  assertNotEquals(
    prepareSource("a", '"one"').encoded,
    prepareSource("a", '"two"').encoded,
  );
  assertNotEquals(
    prepareSource("a", '"name"').encoded,
    prepareSource("a", "name").encoded,
  );
});

Deno.test("Primes are independent operators, not quote delimiters", () => {
  assertEquals(
    tokenizeTla("state' = state /\\ next' = TRUE").map(({ text }) => text),
    ["state", "'", "=", "state", "/\\", "next", "'", "=", "TRUE"],
  );
  assertNotEquals(
    prepareSource("a", "state'").encoded,
    prepareSource("a", "state").encoded,
  );
});

Deno.test("TLA identifiers, literals and maximal operators remain distinct", () => {
  assertEquals(
    tokenizeTla(String.raw`value_1 |-> 12.5 .. 20 /\ x \in S`).map(
      ({ text }) => text,
    ),
    ["value_1", "|->", "12.5", "..", "20", "/\\", "x", "\\in", "S"],
  );
  assertEquals(
    tokenizeTla(String.raw`\b101 \o17 \hAF`).map(({ kind }) => kind),
    ["number", "number", "number"],
  );
  assertNotEquals(
    prepareSource("a", "x <= y").encoded,
    prepareSource("a", "x < = y").encoded,
  );
  assertEquals(
    tokenizeTla("x^+ (+) y <: z").map(({ text }) => text),
    ["x", "^+", "(+)", "y", "<:", "z"],
  );
  assertNotEquals(
    prepareSource("a", "123name").encoded,
    prepareSource("a", "123 name").encoded,
  );
});

Deno.test("Set difference stays distinct from named set operators", () => {
  assertEquals(
    tokenizeTla(String.raw`States \ Known \cup Extra`).map(
      ({ kind, text }) => ({
        kind,
        text,
      }),
    ),
    [
      { kind: "identifier", text: "States" },
      { kind: "operator", text: "\\" },
      { kind: "identifier", text: "Known" },
      { kind: "operator", text: "\\cup" },
      { kind: "identifier", text: "Extra" },
    ],
  );
});

Deno.test("Source positions preserve CRLF and Unicode UTF-16 offsets", () => {
  const tokens = tokenizeTla('α\r\n(* 😀 *)\r\n"😀"\nβ');
  assertEquals(tokens[0]?.start, { column: 1, line: 1, position: 0 });
  assertEquals(tokens[1]?.start, { column: 1, line: 3, position: 13 });
  assertEquals(tokens[1]?.end, { column: 5, line: 3, position: 17 });
  assertEquals(tokens[2]?.start, { column: 1, line: 4, position: 18 });
  assertEquals(tokenizeTla("a\rb")[1]?.start, {
    column: 1,
    line: 2,
    position: 2,
  });
});

Deno.test("Canonical tokens contain only lexer-safe ASCII words", () => {
  const prepared = prepareSource(
    "sample.tla",
    String.raw`x' = "// (* \"safe\" *)" /\ α \in {1}`,
  );
  assertEquals(prepared.encoded.split("\n").length, prepared.tokens.length);
  assertEquals(/^[a-zA-Z0-9\n]+$/.test(prepared.encoded), true);
  assertEquals(
    prepareSource("a", "x (* comment *) = 1").encoded,
    prepareSource("b", "x\r\n= 1").encoded,
  );
  assertNotEquals(
    prepareSource("a", '"\ud800"').encoded,
    prepareSource("b", '"\ufffd"').encoded,
  );
});

Deno.test("Malformed lexical input fails rather than disappearing", () => {
  for (const source of [
    '"unterminated',
    '"line\nbreak"',
    String.raw`"bad\q"`,
    "(* unfinished",
    "*)",
    "😀",
  ]) {
    assertThrows(() => tokenizeTla(source));
  }
  assertEquals(
    prepareSource("empty", "\\* comment\n(* nested (* comment *) *)").tokens,
    [],
  );
});
