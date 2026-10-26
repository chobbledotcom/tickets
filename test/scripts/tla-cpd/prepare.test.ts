import { assertEquals, assertThrows } from "@std/assert";
import {
  prepareSource,
  sourceRange,
  translateReport,
} from "#scripts/tla-cpd/prepare.ts";

const generatedRange = (start: number, end: number, endColumn: number) => ({
  endLoc: { column: endColumn, line: end, position: 0 },
  name: "/prepared/0.txt",
  startLoc: { column: 0, line: start, position: 0 },
});

Deno.test("Token ranges map back across comments, CRLF, strings and primes", () => {
  const prepared = prepareSource(
    "verification/example.tla",
    'α\r\n(* omitted *) x\' = "😀"',
  );
  const endColumn = prepared.encoded.split("\n")[4]?.length ?? 0;
  const range = sourceRange(prepared, generatedRange(2, 5, endColumn));
  assertEquals(range, {
    end: 2,
    endLoc: { column: 24, line: 2, position: 26 },
    name: "verification/example.tla",
    start: 2,
    startLoc: { column: 15, line: 2, position: 17 },
  });
  assertEquals(
    prepared.source.slice(range.startLoc.position, range.endLoc.position),
    'x\' = "😀"',
  );
});

Deno.test("Exclusive range endings at the next line do not consume another token", () => {
  const prepared = prepareSource("source.tla", "a\n b\n c");
  const range = sourceRange(prepared, generatedRange(1, 3, 0));
  assertEquals(range.startLoc, { column: 1, line: 1, position: 0 });
  assertEquals(range.endLoc, { column: 3, line: 2, position: 4 });
});

Deno.test("Invalid and out-of-bounds checker coordinates fail closed", () => {
  const prepared = prepareSource("source.tla", "a b");
  for (const range of [
    generatedRange(0, 1, 2),
    generatedRange(1, 8, 1),
    generatedRange(2, 1, 2),
    generatedRange(1, 1, 999),
    generatedRange(1, 1, 1),
  ]) {
    assertThrows(() => sourceRange(prepared, range));
  }
});

Deno.test("JSON clone reports name original sources and contain original fragments", () => {
  const prepared = prepareSource("verification/source.tla", "a (* gap *) = b");
  const files = new Map([["/prepared/0.txt", prepared]]);
  const endColumn = prepared.encoded.split("\n")[2]?.length ?? 0;
  const range = generatedRange(1, 3, endColumn);
  const translated = translateReport(
    {
      duplicates: [
        { firstFile: range, fragment: "encoded", secondFile: range, tokens: 3 },
      ],
      statistics: { total: { sources: 1, tokens: 3 } },
    },
    files,
  );
  const duplicates = translated.duplicates as Record<string, unknown>[];
  assertEquals(duplicates[0]?.firstFile, sourceRange(prepared, range));
  assertEquals(duplicates[0]?.fragment, prepared.source);
  assertEquals(duplicates[0]?.format, "tla");
  assertEquals(duplicates[0]?.tokens, 3);
});

Deno.test("Missing or empty prepared-token analysis and unknown sources fail closed", () => {
  for (const report of [
    {},
    { duplicates: [], statistics: { total: { sources: 0, tokens: 0 } } },
    { duplicates: [], statistics: { total: { sources: 1, tokens: 0 } } },
    { statistics: { total: { sources: 1, tokens: 1 } } },
    {
      duplicates: [{ firstFile: { name: "unknown" } }],
      statistics: { total: { sources: 1, tokens: 1 } },
    },
  ]) {
    assertThrows(() => translateReport(report, new Map()));
  }
});

Deno.test("A report that omits a selected source fails", () => {
  const prepared = prepareSource("source.tla", "a b");
  assertThrows(() =>
    translateReport(
      { duplicates: [], statistics: { total: { sources: 1, tokens: 2 } } },
      new Map([
        ["/prepared/0.txt", prepared],
        ["/prepared/1.txt", prepared],
      ]),
    ),
  );
});
