const encoder = new TextEncoder();

export const write = (s: string): number =>
  Deno.stdout.writeSync(encoder.encode(s));
