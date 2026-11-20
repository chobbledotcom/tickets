import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readSourceDefinition } from "#scripts/model-guides/source.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

const fixture = `/** Adds one to a value. */
export const add = (value: number): number => {
  return value + 1;
};

export function readName(input: string): string {
  return input;
}

export class Counter {
  value = 1;
}

export interface Shape {
  name: string;
}

export type Kind = "one" | "two";

export enum Colour {
  Red,
}

const hidden = 1;
export { hidden as visible };

export default function main(): void {}
`;

const signatureOf = (path: string, content: string, symbol: string): string =>
  readSourceDefinition(path, content, symbol).signature;

/* jscpd:ignore-start -- static data, not code */
const SIMPLE_DECLARATIONS = [
  [
    "pattern.ts",
    "const { hidden } = value;\nexport const visible = 1;\n",
    "visible",
    "export const visible = 1;",
  ],
  [
    "data.ts",
    "export const data = { count: 1 };\n",
    "data",
    "export const data = { count: 1 };",
  ],
  [
    "one.ts",
    "export const one = () => 1;\n",
    "one",
    "export const one = () => ...",
  ],
  [
    "declare.ts",
    "export declare function read(): void;\n",
    "read",
    "export declare function read(): void;",
  ],
] as const;
/* jscpd:ignore-end */

describe("readSourceDefinition", () => {
  test("reads a doc comment and an arrow signature", () => {
    const definition = readSourceDefinition("fixture.ts", fixture, "add");
    expect(definition.line).toBe(2);
    expect(definition.text.startsWith("/** Adds one to a value. */")).toBe(
      true,
    );
    expect(definition.signature).toBe(
      "export const add = (value: number): number => { ... }",
    );
  });

  test("reads a function, class, interface, type, and enum", () => {
    const signature = (symbol: string) =>
      readSourceDefinition("fixture.ts", fixture, symbol).signature;
    expect([signature("readName"), signature("Counter")]).toEqual([
      "export function readName(input: string): string { ... }",
      "export class Counter { ... }",
    ]);
    expectIncludesAll(
      [signature("Shape"), signature("Kind"), signature("Colour")].join("\n"),
      [
        "export interface Shape",
        'export type Kind = "one" | "two";',
        "export enum Colour",
      ],
    );
  });

  test("resolves an export alias to its local declaration", () => {
    const definition = readSourceDefinition("fixture.ts", fixture, "visible");
    expect(definition.signature).toBe("const hidden = 1;");
    expect(definition.line).toBe(24);
  });

  test("resolves a string export name to its local declaration", () => {
    const content = 'const hidden = 1;\nexport { hidden as "visible-name" };\n';
    const definition = readSourceDefinition(
      "string-name.ts",
      content,
      "visible-name",
    );
    expect(definition.signature).toBe("const hidden = 1;");
  });

  test("resolves a default declaration by its local and default name", () => {
    const named = readSourceDefinition("fixture.ts", fixture, "main");
    const unnamed = readSourceDefinition("fixture.ts", fixture, "default");
    expect(named.signature).toContain("export default function main");
    expect(unnamed.signature).toBe(named.signature);
  });

  test("returns the full declaration when the caller asks for it", () => {
    const definition = readSourceDefinition(
      "fixture.ts",
      fixture,
      "add",
      "declaration",
    );
    expect(definition.signature).toContain("return value + 1;");
    expect(definition.signature).toBe(definition.text);
  });

  test("reads one declaration with several names", () => {
    const content = "export const one = 1, two = 2;\n";
    const signatures = ["one", "two"].map(
      (symbol) => readSourceDefinition("multi.ts", content, symbol).signature,
    );
    expect(signatures).toEqual([content.trimEnd(), content.trimEnd()]);
  });

  test("reads simple declarations", () => {
    expect(
      SIMPLE_DECLARATIONS.map(([path, content, symbol]) =>
        signatureOf(path, content, symbol),
      ),
    ).toEqual(SIMPLE_DECLARATIONS.map(([, , , expected]) => expected));
  });

  test("reads a default expression and an anonymous default function", () => {
    const signatures = [
      "export default 1;\n",
      "export default function () {}\n",
    ].map(
      (content) =>
        readSourceDefinition("default.ts", content, "default").signature,
    );
    expect(signatures).toEqual([
      "export default 1;",
      "export default function () { ... }",
    ]);
  });

  test("clips a long signature", () => {
    const body = Array.from({ length: 30 }, (_, index) => `  line${index}: 1,`);
    const content = `export const data = {\n${body.join("\n")}\n};\n`;
    const signature = signatureOf("long.ts", content, "data");
    expect(signature.split("\n").length).toBe(25);
    expect(signature.endsWith("// ...")).toBe(true);
  });

  test("reads a default class without a name", () => {
    const content = "export default class { value = 1; }\n";
    expect(signatureOf("default.ts", content, "default")).toBe(
      "export default class { ... }",
    );
  });

  test("rejects a missing declaration and a duplicate declaration", () => {
    expect(() =>
      readSourceDefinition("fixture.ts", fixture, "missing"),
    ).toThrow(/has no top-level declaration named missing/);
    expect(() =>
      readSourceDefinition(
        "dup.ts",
        "export const same = 1;\nexport const same = 2;\n",
        "same",
      ),
    ).toThrow(/declares same more than once/);
  });

  test("rejects a declaration that does not parse", () => {
    expect(() =>
      readSourceDefinition("bad.ts", "export const = ;\n", "bad"),
    ).toThrow(/does not parse/);
  });

  test("does not follow an export from another module", () => {
    const content = 'export { thing } from "./other.ts";\n';
    expect(() =>
      readSourceDefinition("re-export.ts", content, "thing"),
    ).toThrow(/has no top-level declaration named thing/);
  });
});
