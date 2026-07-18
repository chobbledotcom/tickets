export interface CapturedCommand {
  command: string | URL;
  options: Deno.CommandOptions;
}

const successfulOutput = (): Deno.CommandOutput => ({
  code: 0,
  signal: null,
  stderr: new Uint8Array(),
  stdout: new Uint8Array(),
  success: true,
});

export const captureCommands = (
  output: Deno.CommandOutput = successfulOutput(),
): {
  Command: (
    command: string | URL,
    options: Deno.CommandOptions,
  ) => { output(): Promise<Deno.CommandOutput> };
  commands: CapturedCommand[];
} => {
  const commands: CapturedCommand[] = [];
  return {
    Command: (command, options) => {
      commands.push({ command, options });
      return { output: () => Promise.resolve(output) };
    },
    commands,
  };
};
