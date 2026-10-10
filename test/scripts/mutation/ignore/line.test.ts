import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  loadIgnoreList,
  mutantKey,
  parseIgnoreLine,
} from "#scripts/mutation/ignore.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { tempFile } from "#test-utils/files.ts";
import { file, mutant } from "./helpers.ts";

describe("writing a mutant key onto one line", () => {
  /** A mutated literal carries its own text into the key, and that text can
   * hold anything a source file can. Each case is a character that would
   * otherwise end the line, start its reason, or be eaten by the spacing
   * around the arrow. */
  const keyFor = (operator: string): string =>
    mutantKey(file, { ...mutant(1), newOperator: '""', operator });

  test("escapes a comment mark, which would start the reason early", () => {
    expect(keyFor("a#b")).toContain(" a%23b→");
  });

  test("escapes a newline, which would end the line outright", () => {
    expect(keyFor("a\nb")).toContain(" a%0ab→");
  });

  test("escapes a percent, so an escape cannot be forged", () => {
    expect(keyFor("a%23b")).toContain(" a%2523b→");
  });

  test("escapes a leading space the arrow's spacing would eat", () => {
    expect(keyFor(" ab")).toContain(" %20ab→");
  });

  test('escapes a trailing space, so "; " and ";" differ', () => {
    expect(keyFor("; ")).not.toBe(keyFor(";"));
    expect(keyFor("; ")).toContain(" ;%20→");
  });

  test("escapes a carriage return, which ends the line just as a newline does", () => {
    expect(keyFor("a\rb")).toContain(" a%0db\u2192");
  });

  test("escapes an arrow, which would read as the one splitting from and to", () => {
    expect(keyFor("left \u2192 right")).toContain(
      " left %e2%86%92 right\u2192",
    );
  });

  /** A path is a name someone else chose, so it can hold anything the line
   * itself uses — including, at the very front, the mark that starts a
   * comment. Reading one back has to give the file it named, because that is
   * what the checker opens on disk. */
  test("keeps a path holding a comment mark, a space, an arrow, or all", () => {
    for (const name of [
      "a#b.ts",
      "a b.ts",
      "a #b.ts",
      "a→b.ts",
      "#a.ts",
      "# a.ts",
      "%a.ts",
      "a:b.ts",
      "a::b.ts",
    ]) {
      const key = mutantKey(`${projectRoot}/src/${name}`, mutant(1));
      const parsed = parseIgnoreLine(`${key}  audited:041pxgm   # a reason`);

      expect(parsed?.key).toBe(key);
      expect(parsed?.sourcePath).toBe(`src/${name}`);
    }
  });

  test("writes a path starting with a comment mark so it cannot read as one", () => {
    expect(mutantKey(`${projectRoot}/src/# a.ts`, mutant(1))).toBe(
      "src/%23 a.ts::fn1 ??→||",
    );
  });

  /** Escaping never writes a bare `%`, so a line carrying one names no real
   * file — it must fail loudly rather than resolve to some other path. */
  test("refuses a written path holding a percent that begins no escape", async () => {
    using temp = tempFile({ prefix: "mutation-ignore-" });
    await Deno.writeTextFile(temp.path, "src/50%.ts::fn1 ?? → ||\n");

    await expect(loadIgnoreList([temp.path])).rejects.toThrow(
      "Malformed equivalent-mutant entry",
    );
  });

  /** The registry README documents the format by quoting example entries, so a
   * comment line can look exactly like one. */
  test("reads a commented-out entry as a comment, not an entry", () => {
    const key = mutantKey(`${projectRoot}/src/example.ts`, mutant(1));

    expect(parseIgnoreLine(`#   ${key}`)).toBe(null);
    expect(parseIgnoreLine(`  # ${key}   # why`)).toBe(null);
    expect(parseIgnoreLine("#")).toBe(null);
  });

  /** Each is a line the loader must refuse rather than turn into a record it
   * would then fail to resolve. */
  test("refuses a line whose fields do not make an entry", () => {
    const key = mutantKey(`${projectRoot}/src/example.ts`, mutant(1));

    // Nothing on the `to` side but a reason.
    expect(parseIgnoreLine(`${key.split("→")[0]}→   # why`)).toBe(null);
    // An arrow, but nothing that reads as a path and an anchor before it.
    expect(parseIgnoreLine("not an entry → nor this")).toBe(null);
    // A path and an anchor, but no mutation after them.
    expect(parseIgnoreLine("src/example.ts::fn1 nothing changes here")).toBe(
      null,
    );
  });

  /** A reason is prose: it may hold anything, including the marks the fields
   * before it use to say where they end. Every one of those fields escapes
   * its own, so the reason cannot be mistaken for any of them. */
  test("reads a reason that holds an arrow, a delimiter, or a colon", () => {
    const key = mutantKey(`${projectRoot}/src/example.ts`, mutant(1));

    for (const reason of [
      "turns a → into b",
      "the a::b case",
      "see Foo::bar and x::y z",
      "a::b → c::d",
    ]) {
      expect(
        parseIgnoreLine(`${key}  audited:041pxgm   # ${reason}`)?.key,
      ).toBe(key);
    }
  });

  /** The `from` and `to` carry a mutated literal's own text, which may hold a
   * `::` — an IPv6 address, a C++ name — with no bearing on where the path
   * ends. */
  test("reads a mutation whose text holds the path delimiter", () => {
    const key = mutantKey(
      `${projectRoot}/src/example.ts`,
      mutant(1, '"[::1]"', '"[::ffff:1.2.3.4]"'),
    );

    expect(parseIgnoreLine(`${key}  audited:041pxgm   # a reason`)?.key).toBe(
      key,
    );
    expect(parseIgnoreLine(`${key}  audited:041pxgm`)?.sourcePath).toBe(
      "src/example.ts",
    );
  });

  test("tells a leading tab from a leading space", () => {
    expect(keyFor("\tab")).not.toBe(keyFor(" ab"));
    expect(keyFor("\tab")).toContain(" %09ab\u2192");
  });

  test("leaves an interior space alone, so a statement reads as itself", () => {
    expect(keyFor("applyFlash(request); ok()")).toContain(
      " applyFlash(request); ok()→",
    );
  });

  /** The stamp rides the line after the mutation and never reaches the key:
   * suppression keys on the mutant alone, so re-stamping a re-derived proof
   * never orphans the record. */
  test("reads a re-audit stamp without putting it in the key", () => {
    const key = mutantKey(`${projectRoot}/src/example.ts`, mutant(1));

    const parsed = parseIgnoreLine(`${key}  audited:041pxgm   # a reason`);

    expect(parsed?.key).toBe(key);
    expect(parsed?.stamp).toBe("audited:041pxgm");
    expect(parsed?.newOperator).toBe("||");
    expect(parsed?.reason).toBe("a reason");
  });

  test("reads a reason that itself mentions a stamp", () => {
    const key = mutantKey(`${projectRoot}/src/example.ts`, mutant(1));

    expect(
      parseIgnoreLine(
        `${key}  audited:041pxgm   # re-derived; the old stamp was audited:abc1234`,
      )?.key,
    ).toBe(key);
  });

  /** The stamp is the proof's date. A line without one rests on a proof
   * nothing dates, so it is malformed exactly like a line with no mutation. */
  test("refuses a line that carries no re-audit stamp", () => {
    const key = mutantKey(`${projectRoot}/src/example.ts`, mutant(1));

    expect(parseIgnoreLine(`${key}   # a reason`)).toBe(null);
    expect(parseIgnoreLine(`${key}`)).toBe(null);
  });

  test("refuses a line carrying a second stamp or a stamp before another token", () => {
    const key = mutantKey(`${projectRoot}/src/example.ts`, mutant(1));

    expect(
      parseIgnoreLine(`${key}  audited:041pxgm audited:abc1234   # why`),
    ).toBe(null);
    expect(parseIgnoreLine(`${key}  audited:041pxgm ||   # why`)).toBe(null);
  });
});
