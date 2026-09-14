import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

const DEVENV_NIX_PATH = "devenv.nix";

describe("CI devenv profile", () => {
  // The `ci` profile must disable the commit-time Git hook. With the hook on,
  // every shell entry runs `deno task precommit` first, so each check step
  // waits minutes before it starts. See the "Runtime Environment" section of
  // AGENTS.md.
  test("disables the commit-time Git hook", async () => {
    const nix = await Deno.readTextFile(DEVENV_NIX_PATH);
    const fromCiProfile = nix.slice(nix.indexOf("profiles.ci.module"));

    expect(fromCiProfile).toContain("git-hooks.enable = false;");
  });
});
