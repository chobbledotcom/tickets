import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { denoCliDeps } from "#scripts/grade-code/cli.ts";
import { tempDir } from "#test-utils/files.ts";
import { CLEAN_CODE } from "./support.ts";

describe("denoCliDeps", () => {
  test("binds the repository's own files and clock to Deno", async () => {
    using dir = tempDir();
    const code = `${dir.path}/code.ts`;
    await Deno.writeTextFile(code, CLEAN_CODE);
    const deps = denoCliDeps();
    expect(await deps.stat(dir.path)).toBe("dir");
    expect(await deps.stat(code)).toBe("file");
    expect(await deps.stat(`${dir.path}/gone.ts`)).toBe("missing");
    expect(await deps.grade.readFile(code)).toBe(CLEAN_CODE);
    expect(await deps.grade.sleep(1)).toBeUndefined();
    expect(deps.grade.now()).toBeGreaterThan(0);
    expect(await deps.aliases()).not.toBeNull();
    expect(await deps.overLimit()).not.toBeNull();
    expect(Array.isArray(await deps.listFiles("scripts/grade-code"))).toBe(
      true,
    );
    const secret = await deps.readSecret();
    expect(secret === null || typeof secret === "string").toBe(true);
    await deps.writeTextFile(`${dir.path}/out.txt`, "kept");
    expect(await Deno.readTextFile(`${dir.path}/out.txt`)).toBe("kept");
  });

  test("lists authored JavaScript but not built bundles", async () => {
    const deps = denoCliDeps();
    const client = await deps.listFiles("src/ui/client");
    expect(client.some((file) => file.endsWith(".js"))).toBe(true);
    const staticDir = await deps.listFiles("src/ui/static");
    expect(staticDir.some((file) => file.endsWith(".js"))).toBe(false);
  });
});
