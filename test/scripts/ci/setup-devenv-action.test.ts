import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";

/**
 * The setup-devenv action pins the devenv CLI to an immutable reference. A
 * branch, a tag, a short SHA, or the Nix registry would let the CLI move
 * without a project change. The action must also install dependencies
 * through the one shared script, so the frozen-lockfile policy holds on
 * every job.
 */

const actionPath = join(
  projectRoot,
  ".github",
  "actions",
  "setup-devenv",
  "action.yml",
);

describe("the setup-devenv action", () => {
  test("pins the devenv CLI to a full commit revision", async () => {
    const action = await Deno.readTextFile(actionPath);
    expect(action).toMatch(
      /nix profile add "?github:cachix\/devenv\/[0-9a-f]{40}#devenv"?/,
    );
  });

  test("installs dependencies through the shared install script", async () => {
    const action = await Deno.readTextFile(actionPath);
    expect(action).toContain(
      "devenv $profile shell -- bash scripts/ci/deno-install.sh",
    );
  });
});
