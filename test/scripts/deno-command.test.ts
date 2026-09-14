import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  commandDetail,
  commandExitCode,
  denoNpmArgs,
} from "#scripts/deno-command.ts";

describe("denoNpmArgs", () => {
  test("builds the deno run -A npm:<pkg> arg list with the extra args", () => {
    expect(denoNpmArgs("biome@2.4.16", ["check", "--write"])).toEqual([
      "run",
      "-A",
      "npm:biome@2.4.16",
      "check",
      "--write",
    ]);
  });

  test("keeps just the scaffold when there are no extra args", () => {
    expect(denoNpmArgs("biome@2.4.16", [])).toEqual([
      "run",
      "-A",
      "npm:biome@2.4.16",
    ]);
  });
});

describe("commandExitCode", () => {
  test("returns the exit code of the spawned command", async () => {
    const ok = await commandExitCode(Deno.execPath(), {
      args: ["eval", "Deno.exit(0)"],
      stderr: "null",
      stdout: "null",
    });
    expect(ok).toBe(0);
    const failed = await commandExitCode(Deno.execPath(), {
      args: ["eval", "Deno.exit(3)"],
      stderr: "null",
      stdout: "null",
    });
    expect(failed).toBe(3);
  });
});

describe("commandDetail", () => {
  test("captures what the spawned command printed", async () => {
    const detail = await commandDetail(Deno.execPath(), {
      args: ["eval", "console.log('out line'); console.error('err line');"],
    });
    expect(detail.code).toBe(0);
    expect(detail.output).toContain("out line");
    expect(detail.output).toContain("err line");
  });

  test("carries a failed child's exit code with its output", async () => {
    const detail = await commandDetail(Deno.execPath(), {
      args: ["eval", "console.error('it broke'); Deno.exit(2);"],
    });
    expect(detail.code).toBe(2);
    expect(detail.output).toContain("it broke");
  });
});
