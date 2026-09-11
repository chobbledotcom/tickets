export interface BiomeCommand {
  args: string[];
  command: string;
}

/** Biome comes from the devenv environment, so the native binary is always
 * on PATH in dev, CI, and the hook. */
export const resolveBiomeCommand = async (
  args: string[],
): Promise<BiomeCommand> => ({ args, command: "biome" });
