import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { definitionIndex, readTlaModule } from "#scripts/model-guides/tla.ts";

const HEADER = "---------------- MODULE Sample ----------------";
const FOOTER =
  "=============================================================================";

const moduleText = (body: string, extendsLine = "EXTENDS Integers"): string =>
  [HEADER, extendsLine, "", "VARIABLES", "  x", "", body, FOOTER, ""].join(
    "\n",
  );

describe("readTlaModule", () => {
  test("reads top-level rules, parameters, references, and extents", () => {
    const text = moduleText(
      [
        "Foo ==",
        "  x = 1",
        "Bar(value) ==",
        "  value > 0 /\\ Foo",
        "Next == Foo \\/ Bar(1)",
      ].join("\n"),
      "EXTENDS Integers, ModelRules, Integers",
    );
    const module = readTlaModule("verification/Sample.tla", text);
    expect(module.module).toBe("Sample");
    expect(module.extends).toEqual(["Integers", "ModelRules"]);
    expect([...module.definitions.keys()]).toEqual(["Foo", "Bar", "Next"]);
    expect(module.definitions.get("Foo")!.text).toBe("Foo ==\n  x = 1");
    expect(module.definitions.get("Bar")!.line).toBe(9);
    expect(module.definitions.get("Bar")!.references).toContain("value");
    expect(module.definitions.get("Bar")!.references).toContain("Foo");
    expect(module.definitions.get("Next")!.references).toEqual(["Foo", "Bar"]);
  });

  test("rejects an invalid module header", () => {
    expect(() =>
      readTlaModule("verification/Bad.tla", "MODULE Bad\n====\n"),
    ).toThrow(/header or end marker is invalid/);
  });

  test("ignores a rule with an unclosed parameter list", () => {
    const text = moduleText("Foo( == TRUE");
    const module = readTlaModule("verification/Sample.tla", text);
    expect([...module.definitions.keys()]).toEqual([]);
  });

  test("removes a comment block that belongs to the next rule", () => {
    const text = moduleText(
      [
        "Foo ==",
        "  TRUE \\* stays with Foo",
        "",
        "\\* This explains Bar.",
        "\\* It is not part of Foo.",
        "Bar ==",
        "  FALSE",
      ].join("\n"),
    );
    const module = readTlaModule("verification/Sample.tla", text);
    expect(module.definitions.get("Foo")!.text).toBe(
      "Foo ==\n  TRUE \\* stays with Foo",
    );
    expect(module.definitions.get("Bar")!.text).toBe("Bar ==\n  FALSE");
  });

  test("rejects a multi-line EXTENDS", () => {
    const text = moduleText("Foo == TRUE", "EXTENDS Integers,");
    expect(() => readTlaModule("verification/Sample.tla", text)).toThrow(
      /multi-line EXTENDS/,
    );
  });

  test("reads an empty EXTENDS and a parenthesised rule", () => {
    const text = moduleText("Foo() == TRUE", "EXTENDS");
    const module = readTlaModule("verification/Sample.tla", text);
    expect(module.extends).toEqual([]);
    expect(module.definitions.get("Foo")!.text).toBe("Foo() == TRUE");
  });
});

describe("definitionIndex", () => {
  test("lets the model win a rule name that a helper also defines", () => {
    const model = readTlaModule(
      "verification/Sample.tla",
      moduleText("Foo == 1"),
    );
    const helper = readTlaModule(
      "verification/Helper.tla",
      moduleText("Foo == 2\nBar == 3"),
    );
    const index = definitionIndex(model, [helper]);
    expect(index.get("Foo")!.text).toBe("Foo == 1");
    expect(index.get("Bar")!.text).toBe("Bar == 3");
  });

  test("keeps the first helper that defines a shared name", () => {
    const model = readTlaModule(
      "verification/Sample.tla",
      moduleText("Foo == 1"),
    );
    const first = readTlaModule(
      "verification/First.tla",
      moduleText("Shared == 1"),
    );
    const second = readTlaModule(
      "verification/Second.tla",
      moduleText("Shared == 2"),
    );
    const index = definitionIndex(model, [first, second]);
    expect(index.get("Shared")!.text).toBe("Shared == 1");
  });
});
