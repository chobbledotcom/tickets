import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { JEV_QUESTIONS } from "#scripts/grade-code/questions.ts";

/** Every rule a question quotes as `"<title>" in AGENTS.md`. */
const citedTitles = (instructions: string): string[] =>
  [...instructions.matchAll(/"([^"]+)" in AGENTS\.md/g)].map(
    ([, title]) => title!,
  );

describe("JEV_QUESTIONS", () => {
  test("quotes only rule titles that AGENTS.md still carries", () => {
    const agents = Deno.readTextFileSync("AGENTS.md");
    const missing = JEV_QUESTIONS.flatMap(({ id, instructions }) =>
      citedTitles(instructions)
        .filter((title) => !agents.includes(title))
        .map((title) => `${id}: "${title}"`),
    );

    expect(missing).toEqual([]);
  });
});
