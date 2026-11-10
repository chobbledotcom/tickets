import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

const DEVENV_NIX_PATH = "devenv.nix";
const TEST_WORKFLOW_PATH = ".github/workflows/test.yml";

/** The body of one profile, from its name to the brace that closes it. */
const profileModule = (nix: string, profile: string): string => {
  const start = nix.indexOf(`profiles.${profile}.module`);
  if (start < 0) throw new Error(`devenv.nix declares no ${profile} profile`);
  return nix.slice(start, nix.indexOf("};", start));
};

describe("CI devenv profile", () => {
  // The `ci` profile must disable the commit-time Git hook. With the hook on,
  // every shell entry runs `deno task precommit` first, so each check step
  // waits minutes before it starts. See the "Runtime Environment" section of
  // AGENTS.md.
  test("disables the commit-time Git hook", async () => {
    const nix = await Deno.readTextFile(DEVENV_NIX_PATH);

    assertStringIncludes(profileModule(nix, "ci"), "git-hooks.enable = false;");
  });

  // Apalache is a release archive that no binary cache serves, and it needs
  // Java. Only `deno task verify:models` runs it.
  test("only the models profile carries Apalache", async () => {
    const nix = await Deno.readTextFile(DEVENV_NIX_PATH);

    expect({
      browser: profileModule(nix, "browser").includes(
        "ticketsModelTools = false;",
      ),
      ci: profileModule(nix, "ci").includes("ticketsModelTools = false;"),
      models: profileModule(nix, "models").includes("ticketsModelTools"),
      modelsHook: profileModule(nix, "models").includes(
        "git-hooks.enable = false;",
      ),
    }).toEqual({ browser: true, ci: true, models: false, modelsHook: true });
  });

  test("the model check step runs in the models profile", async () => {
    const workflow = await Deno.readTextFile(TEST_WORKFLOW_PATH);

    assertStringIncludes(
      workflow,
      [
        "      - name: Check machine safety models",
        "        shell: devenv --profile models shell bash -- -e {0}",
        "        run: deno task verify:models",
      ].join("\n"),
    );
  });
});
