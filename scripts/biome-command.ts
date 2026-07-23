import { denoNpmArgs } from "#scripts/deno-command.ts";

export const BIOME_NPM_PACKAGE = "@biomejs/biome@2.4.16";

export interface BiomeCommand {
  args: string[];
  command: string;
}

type CommandAvailable = (name: string) => Promise<boolean>;

const commandAvailable: CommandAvailable = async (name) => {
  try {
    const result = await new Deno.Command("which", { args: [name] }).output();
    return result.success;
  } catch {
    return false;
  }
};

/** Resolve the native Biome binary or the pinned package fallback. */
export const resolveBiomeCommand = async (
  args: string[],
  available: CommandAvailable = commandAvailable,
): Promise<BiomeCommand> => {
  const nativeAvailable = await available("biome");
  return nativeAvailable
    ? { args, command: "biome" }
    : {
        args: denoNpmArgs(BIOME_NPM_PACKAGE, args),
        command: Deno.execPath(),
      };
};
