export interface ScriptIo {
  args: string[];
  getEnv: (key: string) => string | undefined;
  stderr: (line: string) => void;
  stdout: (line: string) => void;
}

/** Give a console task its standard Deno inputs and exit with its result. */
export const runDenoScript = async (
  run: (io: ScriptIo) => Promise<number>,
): Promise<never> => {
  const exitCode = await run({
    args: Deno.args,
    getEnv: (key) => Deno.env.get(key),
    stderr: (line) => console.error(line),
    stdout: (line) => console.log(line),
  });
  return Deno.exit(exitCode);
};
