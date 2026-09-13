import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { findIssues } from "#scripts/check-alias-exports/rules.ts";

describe("alias export resolution", () => {
  const cases: [
    name: string,
    setup: string,
    declaration: string,
    exported: string,
    target: string | null,
  ][] = [
    [
      "restores the source name after a local import rename",
      'import { Token as Local } from "./model.ts";',
      "const Token = Local;",
      "Token",
      null,
    ],
    [
      "follows immutable value chains",
      'import { byParent } from "./model.ts"; const first = byParent; const second = first.getIds;',
      "const Alias = second;",
      "Alias",
      "byParent.getIds",
    ],
    [
      "follows plain type chains",
      'import type { Token } from "./model.ts"; type First = Token; type Second = First;',
      "type Alias = Second;",
      "Alias",
      "Token",
    ],
    [
      "resolves qualified namespace types",
      'import type * as model from "./model.ts";',
      "type Alias = model.Nested.Token;",
      "Alias",
      "model.Nested.Token",
    ],
    [
      "normalises renamed roots in member diagnostics",
      'import { Token as Local } from "./model.ts";',
      "const Alias = Local.parse;",
      "Alias",
      "Token.parse",
    ],
    [
      "normalises renamed roots in type diagnostics",
      'import type { Token as Local } from "./model.ts";',
      "type Alias = Local;",
      "Alias",
      "Token",
    ],
    [
      "keeps an explicit annotation contract",
      'import system from "./system.ts";',
      "const Alias: Messages = system;",
      "Alias",
      null,
    ],
    [
      "recognises typeof of the same target through another import spelling",
      'import { Token, Token as Local } from "./model.ts"; const first = Local.parse;',
      "const Alias: typeof Token.parse = first;",
      "Alias",
      "Token.parse",
    ],
    [
      "keeps typeof of a different member as a contract",
      'import { Token } from "./model.ts";',
      "const Alias: typeof Token.other = Token.parse;",
      "Alias",
      null,
    ],
    [
      "recognises typeof of the same destructured object",
      'import { Token } from "./model.ts";',
      "const { parse: Alias }: typeof Token = Token;",
      "Alias",
      "Token.parse",
    ],
    [
      "keeps identical names from different modules distinct",
      'import { Token } from "./model.ts"; import { Token as Other } from "./other.ts";',
      "const Alias: typeof Other = Token;",
      "Alias",
      null,
    ],
    [
      "does not follow mutable bindings",
      'import { Token } from "./model.ts"; let local = Token;',
      "const Alias = local;",
      "Alias",
      null,
    ],
    [
      "does not follow calls",
      'import { Token } from "./model.ts"; const local = Token();',
      "const Alias = local;",
      "Alias",
      null,
    ],
    [
      "keeps destructured defaults",
      'import { Token } from "./model.ts";',
      "const { parse: Alias = fallback } = Token;",
      "Alias",
      null,
    ],
    [
      "keeps true type specialisations",
      'import type * as model from "./model.ts";',
      "type Alias = model.Token<string>;",
      "Alias",
      null,
    ],
    [
      "keeps a type declaration with its own parameters",
      'import type { Token } from "./model.ts";',
      "type Alias<T> = Token;",
      "Alias",
      null,
    ],
    [
      "does not follow a member of a call result",
      'import { Token } from "./model.ts";',
      "const Alias = Token().parse;",
      "Alias",
      null,
    ],
    [
      "stops type cycles without an imported root",
      "type First = Second; type Second = First;",
      "type Alias = First;",
      "Alias",
      null,
    ],
    [
      "preserves an earlier annotation contract through a chain",
      'import { Token } from "./model.ts"; const local: Contract = Token;',
      "const Alias = local;",
      "Alias",
      null,
    ],
    [
      "reads type-only named import specifiers",
      'import { type Token as Local } from "./model.ts";',
      "type Alias = Local;",
      "Alias",
      "Token",
    ],
    [
      "keeps value declarations out of the type namespace",
      'import type { Token as Local } from "./model.ts"; const Local = 1;',
      "const Alias = Local;",
      "Alias",
      null,
    ],
    [
      "keeps type declarations out of the value namespace",
      'import { Token as Local } from "./model.ts"; type Local = string;',
      "type Alias = Local;",
      "Alias",
      null,
    ],
  ];

  for (const [name, setup, declaration, exported, target] of cases) {
    const forms = [
      ["inline", `export ${declaration}`, 2],
      ["clause", `${declaration}\nexport { ${exported} };`, 3],
    ] as const;
    for (const [form, source, line] of forms) {
      test(`${name} (${form})`, () => {
        const content = `${setup}\n${source}`;
        const issues = findIssues("resolution.ts", content);
        expect(issues).toEqual(
          target === null
            ? []
            : [
                {
                  exported,
                  fix: `export ${target} itself, and let callers use it`,
                  line,
                  problem: `"${exported}" renames the imported ${target}`,
                  rule: "alias-export",
                  target,
                },
              ],
        );
      });
    }
  }
});

describe("direct export identities", () => {
  for (const clause of [false, true]) {
    test(`restores a renamed import directly (${clause ? "type" : "value"})`, () => {
      expect(
        findIssues(
          "restore.ts",
          `
        import ${clause ? "type " : ""}{ Token as Local } from "./model.ts";
        export ${clause ? "type " : ""}{ Local as Token };
      `,
        ),
      ).toEqual([]);
    });

    for (const originalDefault of [false, true]) {
      test(`default export retains original identity (${clause ? "clause" : "inline"}, ${originalDefault ? "default" : "named"})`, () => {
        const issues = findIssues(
          "default.ts",
          `
          import ${originalDefault ? "Local" : "{ Token as Local }"} from "./model.ts";
          ${clause ? "export { Local as default };" : "export default Local;"}
        `,
        );
        expect(
          issues.map(({ exported, target }) => ({ exported, target })),
        ).toEqual(
          originalDefault ? [] : [{ exported: "default", target: "Token" }],
        );
      });
    }
  }
});
