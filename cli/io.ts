import { CliError } from "./errors.ts";

const encoder = new TextEncoder();

export const writeOut = async (text: string): Promise<void> => {
  await Deno.stdout.write(encoder.encode(text));
};

export const writeErr = async (text: string): Promise<void> => {
  await Deno.stderr.write(encoder.encode(text));
};

/** The stdin side readStdin consumes. */
export type StdinLike = {
  isTerminal: () => boolean;
  read: (buffer: Uint8Array) => Promise<number | null>;
};

/** Read all of stdin as text, for a "-" body argument. */
export const readStdin = async (
  input: StdinLike = Deno.stdin,
): Promise<string> => {
  if (input.isTerminal()) {
    throw new CliError(
      "usage",
      "The body argument '-' reads stdin, but stdin is a terminal. Pipe the JSON body instead.",
    );
  }
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(16 * 1024);
  for (;;) {
    const read = await input.read(buffer);
    if (read === null) break;
    chunks.push(buffer.slice(0, read));
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(all);
};
