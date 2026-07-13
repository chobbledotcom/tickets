import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { commandExitCode, denoNpmArgs } from "../../scripts/deno-command.ts";

describe("denoNpmArgs", () => {
  test("builds the deno run -A npm:<pkg> arg list with the extra args", () => {
    expect(denoNpmArgs("jscpd@5.0.12", ["--config", ".jscpd.json"])).toEqual([
      "run",
      "-A",
      "npm:jscpd@5.0.12",
      "--config",
      ".jscpd.json",
    ]);
  });

  test("keeps just the scaffold when there are no extra args", () => {
    expect(denoNpmArgs("biome", [])).toEqual(["run", "-A", "npm:biome"]);
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
