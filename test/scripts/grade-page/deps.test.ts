import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { denoCliDeps } from "#scripts/grade-page/cli.ts";
import { tempDir } from "#test-utils/files.ts";
import { CLEAN_PAGE } from "./support.ts";

describe("denoCliDeps", () => {
  test("binds the repository's own files and clock to Deno", async () => {
    using dir = tempDir();
    const page = `${dir.path}/page.ts`;
    await Deno.writeTextFile(page, CLEAN_PAGE);
    const deps = denoCliDeps();
    expect(await deps.stat(dir.path)).toBe("dir");
    expect(await deps.stat(page)).toBe("file");
    expect(await deps.stat(`${dir.path}/gone.ts`)).toBe("missing");
    expect(await deps.grade.readFile(page)).toBe(CLEAN_PAGE);
    expect(await deps.grade.sleep(1)).toBeUndefined();
    expect(deps.grade.now()).toBeGreaterThan(0);
    expect(await deps.aliases()).not.toBeNull();
    expect(await deps.overLimit()).not.toBeNull();
    expect(Array.isArray(await deps.listFiles("scripts/grade-page"))).toBe(
      true,
    );
    expect(["string", "null"]).toContain(typeof (await deps.readSecret()));
    await deps.writeTextFile(`${dir.path}/out.txt`, "kept");
    expect(await Deno.readTextFile(`${dir.path}/out.txt`)).toBe("kept");
  });
});
