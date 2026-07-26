import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  BIOME_NPM_PACKAGE,
  resolveBiomeCommand,
} from "#scripts/biome-command.ts";
import { captureCommands } from "#test-utils/command-capture.ts";

describe("Biome command resolution", () => {
  test("installs the version biome.json is written against", async () => {
    const config = JSON.parse(await Deno.readTextFile("biome.json"));
    const schemaVersion = new URL(config.$schema).pathname.split("/")[2];

    expect(BIOME_NPM_PACKAGE).toBe(`@biomejs/biome@${schemaVersion}`);
  });

  test("uses the native Biome command when it is available", async () => {
    const captured = captureCommands();
    const commandNamespace = Deno as unknown as {
      Command: typeof captured.Command;
    };
    using _command = stub(commandNamespace, "Command", captured.Command);

    expect(await resolveBiomeCommand(["lint", "source.ts"])).toEqual({
      args: ["lint", "source.ts"],
      command: "biome",
    });
    expect(captured.commands).toEqual([
      { command: "which", options: { args: ["biome"] } },
    ]);
  });

  test("uses the pinned package when command discovery fails", async () => {
    const commandNamespace = Deno as unknown as {
      Command: (...args: unknown[]) => unknown;
    };
    using _command = stub(commandNamespace, "Command", function failCommand() {
      throw new Error("which unavailable");
    });

    expect(await resolveBiomeCommand(["lint", "source.ts"])).toEqual({
      args: ["run", "-A", `npm:${BIOME_NPM_PACKAGE}`, "lint", "source.ts"],
      command: Deno.execPath(),
    });
  });
});
