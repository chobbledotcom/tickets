import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withTempDir } from "#test-utils/files.ts";

/** The exact pre-migration wrapper prek kept as pre-commit.legacy. */
const KNOWN_LEGACY = `#!/usr/bin/env sh
# Installed by tickets flake.nix
exec deno task precommit
`;

const MANAGED_HOOK = "#!/bin/sh\n: the managed hook\n";

/** The repo-relative script, as an absolute path for a cwd'd subprocess. */
const removalScript = new URL(
  "../../../scripts/devenv/remove-legacy-hook.sh",
  import.meta.url,
);

/** Plant a git repo whose hooks dir holds the managed hook plus `legacy`. */
const withLegacyRepo = (
  legacy: string | null,
  run: (repo: string) => Promise<number>,
): Promise<number> =>
  withTempDir(async (repo) => {
    const git = new Deno.Command("git", {
      args: ["init", "--quiet", repo],
      stdin: "null",
    });
    expect((await git.output()).code).toBe(0);
    await Deno.mkdir(`${repo}/.git/hooks`, { recursive: true });
    if (legacy !== null) {
      await Deno.writeTextFile(`${repo}/.git/hooks/pre-commit.legacy`, legacy);
    }
    await Deno.writeTextFile(`${repo}/.git/hooks/pre-commit`, MANAGED_HOOK);
    return await run(repo);
  });

const runRemoval = async (cwd: string): Promise<number> => {
  const run = new Deno.Command("bash", {
    args: [removalScript.pathname],
    cwd,
    stderr: "inherit",
    stdin: "null",
    stdout: "inherit",
  });
  return (await run.output()).code;
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
};

const legacyHook = (repo: string): string =>
  `${repo}/.git/hooks/pre-commit.legacy`;

describe("remove-legacy-hook.sh", () => {
  test("removes the preserved pre-migration wrapper, not the managed hook", async () => {
    await withLegacyRepo(KNOWN_LEGACY, async (repo) => {
      await runRemoval(repo);
      expect(await fileExists(legacyHook(repo))).toBe(false);
      expect(await Deno.readTextFile(`${repo}/.git/hooks/pre-commit`)).toBe(
        MANAGED_HOOK,
      );
      return 0;
    });
  });

  test("keeps a legacy hook a person changed", async () => {
    await withLegacyRepo(`${KNOWN_LEGACY}# extra line\n`, async (repo) => {
      await runRemoval(repo);
      expect(await fileExists(legacyHook(repo))).toBe(true);
      return 0;
    });
  });

  test("stays a quiet no-op outside a git repo", async () => {
    const code = await withTempDir((dir) => runRemoval(dir));
    expect(code).toBe(0);
  });

  test("stays a quiet no-op when no legacy hook exists", async () => {
    const code = await withLegacyRepo(null, (repo) => runRemoval(repo));
    expect(code).toBe(0);
  });
});
