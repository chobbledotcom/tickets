import { stub } from "@std/testing/mock";

export interface CapturedCommand {
  command: string | URL;
  options: Deno.CommandOptions;
}

/** The captured stand-in for `Deno.Command`: records what was asked, answers
 *  with the captured output. A spawned stand-in reports pid 0, so the runner's
 *  process-group kill names no real group. */
export type CapturedCommandFactory = (
  command: string | URL,
  options: Deno.CommandOptions,
) => {
  output(): Promise<Deno.CommandOutput>;
  spawn(): Deno.ChildProcess;
};

const successfulOutput = (): Deno.CommandOutput => ({
  code: 0,
  signal: null,
  stderr: new Uint8Array(),
  stdout: new Uint8Array(),
  success: true,
});

const streamOf = (bytes: Uint8Array): Deno.ChildProcess["stdout"] =>
  (new Response(bytes as BodyInit).body ??
    new ReadableStream()) as Deno.ChildProcess["stdout"];

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
      return {
        output: () => Promise.resolve(output),
        spawn: () =>
          stubChildProcess({
            kill: () => true,
            pid: 0,
            status: Promise.resolve(output),
            stderr: streamOf(output.stderr),
            stdout: streamOf(output.stdout),
          }),
      };
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
