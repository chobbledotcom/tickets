const encoder = new TextEncoder();

export const writeOut = (text: string): Promise<void> =>
  Deno.stdout.write(encoder.encode(text)).then(() => undefined);

export const writeErr = (text: string): Promise<void> =>
  Deno.stderr.write(encoder.encode(text)).then(() => undefined);

export const clearScreen = (): Promise<void> => writeOut("\x1b[2J\x1b[H");
