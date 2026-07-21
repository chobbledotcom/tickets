import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  applyMutant,
  generateMutants,
  type Mutant,
} from "#scripts/mutation/generate.ts";

const mutationLabels = (content: string, exhaustive = false): string[] =>
  generateMutants(content, "sample.ts", exhaustive).map(
    (mutant) => `${mutant.operator} -> ${mutant.newOperator}`,
  );

const changedSources = (content: string, exhaustive = false): string[] =>
  generateMutants(content, "sample.ts", exhaustive).map((mutant) =>
    applyMutant(content, mutant),
  );

const mutantAt = (
  content: string,
  predicate: (mutant: Mutant) => boolean,
): string => {
  const mutant = generateMutants(content, "sample.ts", true).find(predicate);
  expect(mutant).toBeDefined();
  return applyMutant(content, mutant!);
};

describe("generateMutants", () => {
  test("keeps the original operator, boolean, and statement-removal mutants", () => {
    const labels = mutationLabels(`
      if (enabled && total >= 1) await persist(true);
    `);

    expect(labels).toContain("&& -> ||");
    expect(labels).toContain(">= -> <");
    expect(labels).toContain("true -> false");
    expect(labels.some((label) => label.includes("await persist"))).toBe(true);
  });

  test("mutates runtime string and number literals", () => {
    const sources = changedSources(`
      export const config = { label: "Adult", retries: 3, empty: "" };
    `);

    expect(sources).toContain(`
      export const config = { label:  "" , retries: 3, empty: "" };
    `);
    expect(sources).toContain(`
      export const config = { label: "Adult", retries:  0 , empty: "" };
    `);
    expect(sources).toContain(`
      export const config = { label: "Adult", retries: 3, empty:  "mutated"  };
    `);
  });

  test("mutates every operator-family dispatch path", () => {
    const labels = mutationLabels(`
      total += 2;
      total -= 1;
      if (!flag || count < 3) total++;
      else total--;
      ++total;
      --total;
      const signed = -total + +count;
    `);

    expect(labels).toContain("+= -> /=");
    expect(labels).toContain("-= -> *=");
    expect(labels).toContain("! -> ∅");
    expect(labels).toContain("|| -> &&");
    expect(labels).toContain("< -> >=");
    expect(labels).toContain("++ -> --");
    expect(labels).toContain("-- -> ++");
    expect(labels).toContain("- -> +");
    expect(labels).toContain("+ -> -");
  });

  test("walks array destructuring holes without crashing", () => {
    const labels = mutationLabels(`
      const [, year, month] = parts;
      export const stamp = year + month;
    `);

    expect(labels).toContain("+ -> *");
  });

  test("generates no mutants for declaration files", () => {
    const content = `
      declare module "*.svg" {
        const content: string;
        export default content;
      }
    `;

    expect(generateMutants(content, "static.d.ts", true)).toEqual([]);
  });

  test("skips ambient declare contexts but mutates runtime code", () => {
    const labels = mutationLabels(`
      declare module "*.svg" {
        const content: string;
        export default content;
      }
      export const runtime = "value";
    `);

    expect(labels).not.toContain('*.svg -> ""');
    expect(labels).toContain('value -> ""');
  });

  test("does not invent mutants for unsupported expression shapes", () => {
    const labels = mutationLabels(`
      let value = 1;
      value & mask;
      "name" in object;
      typeof value;
      value;
    `);

    expect(labels.some((label) => label.startsWith("& ->"))).toBe(false);
    expect(labels.some((label) => label.startsWith("in ->"))).toBe(false);
    expect(labels.some((label) => label.startsWith("typeof ->"))).toBe(false);
    expect(labels).not.toContain("value; -> (removed)");
  });

  test("removes direct calls and awaited calls", () => {
    const labels = mutationLabels(`
      persist();
      await persist();
      reallyLongSideEffectName(alpha, beta, gamma, delta, epsilon);
    `);

    expect(labels).toContain("persist(); -> (removed)");
    expect(labels).toContain("await persist(); -> (removed)");
    expect(labels.some((label) => label.includes("… -> (removed)"))).toBe(true);
  });

  test("does not mutate import/export module specifiers or type-only literals", () => {
    const labels = mutationLabels(`
      import thing from "pkg";
      export { thing } from "pkg2";
      type Flags = { ok: true; label: "type-only"; count: 1 };
      export const runtime = "value";
    `);

    expect(labels).not.toContain('pkg -> ""');
    expect(labels).not.toContain('pkg2 -> ""');
    expect(labels).not.toContain("true -> false");
    expect(labels).not.toContain("1 -> 0");
    expect(labels).toContain('value -> ""');
  });

  test("skips TypeScript-only literals under every non-runtime field", () => {
    const labels = mutationLabels(`
      type Alias<T extends "type-param"> = T;
      const box = null as Box<"type-arg">;
      class Child extends Parent<"super-type"> {}
      function returns(): "return-type" {
        return "runtime";
      }
    `);

    expect(labels).not.toContain('type-param -> ""');
    expect(labels).not.toContain('type-arg -> ""');
    expect(labels).not.toContain('super-type -> ""');
    expect(labels).not.toContain('return-type -> ""');
    expect(labels).toContain('runtime -> ""');
  });

  test("mutates return values, throws, ternaries, and loop control", () => {
    const content = `
      export const pick = (flag: boolean): number => flag ? 1 : 2;
      export function value() {
        if (pick(true) > 1) throw new Error("bad");
        for (let i = 0; i < 3; i++) {
          if (i === 2) break;
          if (i === 1) continue;
        }
        return pick(false);
      }
    `;

    const labels = mutationLabels(content, true);
    expect(labels).toContain("?: -> arms swapped");
    expect(labels).toContain("?: -> consequent only");
    expect(labels).toContain("?: -> alternate only");
    expect(labels).toContain("return pick(false) -> return undefined");
    expect(labels.some((label) => label.includes("throw new Error"))).toBe(
      true,
    );
    expect(labels).toContain("break; -> (removed)");
    expect(labels).toContain("continue; -> (removed)");
  });

  test("leaves valueless returns alone and clips long return labels", () => {
    const labels = mutationLabels(`
      function empty() {
        return;
      }
      function verbose() {
        return veryLongExpressionName(alpha, beta, gamma, delta, epsilon);
      }
    `);

    expect(labels).not.toContain("return; -> return undefined");
    expect(
      labels.some(
        (label) =>
          label.includes("return veryLongExpressionName") &&
          label.includes("…"),
      ),
    ).toBe(true);
  });

  test("keeps forced ternary arms in exhaustive mode only", () => {
    const labels = mutationLabels("const value = flag ? left() : right();");

    expect(labels).toContain("?: -> arms swapped");
    expect(labels).not.toContain("?: -> consequent only");
    expect(labels).not.toContain("?: -> alternate only");
  });

  test("applies ternary mutants to valid replacement spans", () => {
    const content = "export const value = flag ? left() : right();";

    expect(
      mutantAt(content, (mutant) => mutant.newOperator === "arms swapped"),
    ).toBe("export const value = flag ?  right() : left() ;");
    expect(
      mutantAt(content, (mutant) => mutant.newOperator === "consequent only"),
    ).toBe("export const value =  left() ;");
    expect(
      mutantAt(content, (mutant) => mutant.newOperator === "alternate only"),
    ).toBe("export const value =  right() ;");
  });

  test("reports source locations for generated mutants", () => {
    const content = "\nconst value = 1 + 2;";
    const mutant = generateMutants(content, "sample.ts", false).find(
      (candidate) => candidate.operator === "+",
    );

    expect(mutant).toMatchObject({ column: 16, end: 19, line: 2, start: 16 });
  });

  test("applies display operators when no replacement override is present", () => {
    const content = "const value = 1 + 2;";
    const mutant = generateMutants(content, "sample.ts", false).find(
      (candidate) => candidate.operator === "+",
    );

    expect(mutant?.replacement).toBeUndefined();
    expect(applyMutant(content, mutant!)).toBe("const value = 1 * 2;");
  });
});
