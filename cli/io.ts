const encoder = new TextEncoder();

export const writeOut = async (text: string): Promise<void> => {
  await Deno.stdout.write(encoder.encode(text));
};

export const writeErr = async (text: string): Promise<void> => {
  await Deno.stderr.write(encoder.encode(text));
};

export const clearScreen = (): Promise<void> => writeOut("\x1b[2J\x1b[H");
