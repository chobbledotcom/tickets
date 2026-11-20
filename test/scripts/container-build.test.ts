import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";
import { tempDir } from "#test-utils/files.ts";

const buildScript = join(projectRoot, "scripts/container/build.sh");

const runBuild = async (libraryPath: string, status: number) => {
  using dir = tempDir();
  const bin = join(dir.path, "bin");
  const scripts = join(dir.path, "scripts/ci");
  await Deno.mkdir(bin);
  await Deno.mkdir(scripts, { recursive: true });
  await Deno.copyFile(
    join(projectRoot, "scripts/ci/deno-install.sh"),
    join(scripts, "deno-install.sh"),
  );

  const commands = {
    deno: `
[ "$LD_LIBRARY_PATH" = "$EXPECTED_LIBRARY_PATH" ] || exit 91
printf 'deno:%s\\n' "$LD_LIBRARY_PATH"
if [ "$1" = cache ]; then mkdir -p "$DENO_DIR"; fi
`,
    devenv: `
printf 'devenv:%s:%s\\n' "\${LD_LIBRARY_PATH+set}" "$*"
exit "$BUILD_STATUS"
`,
  };
  for (const [name, body] of Object.entries(commands)) {
    const path = join(bin, name);
    await Deno.writeTextFile(path, `#!/usr/bin/env bash\nset -eu\n${body}`);
    await Deno.chmod(path, 0o755);
  }

  return await new Deno.Command("bash", {
    args: [buildScript],
    cwd: dir.path,
    env: {
      BUILD_STATUS: String(status),
      EXPECTED_LIBRARY_PATH: libraryPath,
      LD_LIBRARY_PATH: libraryPath,
      PATH: `${bin}:${Deno.env.get("PATH")}`,
    },
    stderr: "piped",
    stdout: "piped",
  }).output();
};

const expectBuild = async (libraryPath: string, status: number) => {
  const result = await runBuild(libraryPath, status);
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(new TextDecoder().decode(result.stdout)).toBe(
    `deno:${libraryPath}\ndeno:${libraryPath}\ndeno:${libraryPath}\ndevenv::build outputs.tickets-image\n`,
  );
  expect(result.code).toBe(status);
};

describe("container build library paths", () => {
  for (const libraryPath of ["", "/tickets-test/lib"]) {
    const state = libraryPath === "" ? "empty" : "set";
    test(`keeps the ${state} Deno path out of devenv`, async () => {
      await expectBuild(libraryPath, 0);
    });
    test(`reports a failed image build with the Deno path ${state}`, async () => {
      await expectBuild(libraryPath, 37);
    });
  }
});
