import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { changedFiles } from "#scripts/precommit/mutation-step.ts";
import { fakeGit } from "#test/scripts/precommit/fake-git.ts";
import { capturedFail, capturedOk } from "#test-utils/captured-output.ts";

/** What `changedFiles` finds when the branch deletes `deleted`, changes
 * `diff`, and `HEAD` still holds `held`. */
const afterDeleting = async (
  deleted: string[],
  held: string[],
  diff: string[] = [],
) =>
  await changedFiles(
    fakeGit({
      base: "origin/main",
      deleted: capturedOk(deleted.map((path) => `${path}\n`).join("")),
      diff: capturedOk(diff.map((path) => `${path}\n`).join("")),
      held,
    }),
  );

/** Each case: the deleted paths, the sources that stay, and the sources that
 * the gate must mutate. */
const MIRRORS: Record<string, [string[], string[], string[]]> = {
  "a template source with the tsx extension": [
    ["test/ui/templates/page.test.tsx"],
    ["src/ui/templates/page.tsx"],
    ["src/ui/templates/page.tsx"],
  ],
  "nothing for a deleted test that mirrors no source, or a deleted document": [
    ["test/integration/flow.test.ts", "docs/guide.md"],
    [],
    [],
  ],
  "the nearest source above a deleted test in a mirror folder": [
    ["test/features/admin/settings-domains/custom-save.test.ts"],
    ["src/features/admin/settings-domains.ts"],
    ["src/features/admin/settings-domains.ts"],
  ],
  "the source that a deleted mirror test used to prove": [
    ["test/shared/dates.test.ts"],
    ["src/shared/dates.ts"],
    ["src/shared/dates.ts"],
  ],
};

describe("changedFiles with deleted tests", () => {
  for (const [name, [deleted, held, expected]] of Object.entries(MIRRORS)) {
    test(`adds ${name}`, async () => {
      expect((await afterDeleting(deleted, held))?.sources).toEqual(expected);
    });
  }

  test("lists a source once when it also changed", async () => {
    const result = await afterDeleting(
      ["test/shared/dates.test.ts"],
      ["src/shared/dates.ts"],
      ["src/shared/dates.ts"],
    );
    expect(result?.sources).toEqual(["src/shared/dates.ts"]);
  });

  test("fails loudly when git cannot list the deleted paths", async () => {
    const git = fakeGit({
      base: "origin/main",
      deleted: capturedFail(1, "boom"),
      diff: capturedOk(""),
    });
    await expect(changedFiles(git)).rejects.toThrow(
      "git diff --diff-filter=D origin/main...HEAD failed: boom",
    );
  });
});
