import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  biomeApplies,
  createPipeline,
  scansFor,
} from "#scripts/edit-checks/pipeline.ts";

describe("Bash post-edit checks", () => {
  test("includes Bash in the zero-duplication source gate", async () => {
    const config = JSON.parse(await Deno.readTextFile(".jscpd.json"));
    expect(config).toMatchObject({
      format: expect.arrayContaining(["bash"]),
      path: expect.arrayContaining(["scripts"]),
      threshold: 0,
    });
  });

  test("selects the main duplication scan for shell scripts", () => {
    expect(scansFor("scripts/container/build.sh")).toEqual([
      { config: ".jscpd.json", format: "bash" },
    ]);
  });

  test("runs the Bash scan without Biome", async () => {
    const calls: string[][] = [];
    const check = createPipeline({
      runTool: (args) => {
        calls.push(args);
        return Promise.resolve({ ok: false, text: "duplicate shell commands" });
      },
    });

    const result = await check("scripts/container/load.sh");

    expect(biomeApplies("scripts/container/load.sh")).toBe(false);
    expect(calls).toEqual([
      [
        "scripts/cpd.ts",
        "--config",
        ".jscpd.json",
        "--reporters",
        "ai",
        "--format",
        "bash",
      ],
    ]);
    expect(result).toContain("jscpd: duplicated code found");
    expect(result).toContain("duplicate shell commands");
  });
});
