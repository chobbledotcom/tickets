import { stub } from "@std/testing/mock";

export interface CapturedCommand {
  command: string | URL;
  options: Deno.CommandOptions;
}

/** The captured stand-in for `Deno.Command`: records what was asked, answers
 *  with the captured output. */
export type CapturedCommandFactory = (
  command: string | URL,
  options: Deno.CommandOptions,
) => { output(): Promise<Deno.CommandOutput> };

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
  Command: CapturedCommandFactory;
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

/**
 * Put a captured stand-in where the real `Deno.Command` lives, for one scope.
 * Returns the stub, so `using` restores the namespace afterwards. The cast is
 * the one contained cost of swapping a namespace member.
 */
export const stubDenoCommand = <F>(command: F): Disposable =>
  stub(Deno as unknown as { Command: F }, "Command", command as never);

/**
 * A Deno.ChildProcess standing in for a spawned command — name only the
 * members the exercised path calls. The one unsafe cast lives here.
 */
export const stubChildProcess = (
  members: Partial<Deno.ChildProcess>,
): Deno.ChildProcess => members as Deno.ChildProcess;
