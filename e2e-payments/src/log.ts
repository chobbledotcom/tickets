/** Tiny timestamped logger. Never pass secrets to these. */

const ts = (): string => new Date().toISOString().slice(11, 23);

// biome-ignore lint/suspicious/noConsole: This module is the CLI output boundary.
export const log = (msg: string): void => console.log(`[${ts()}] ${msg}`);
// biome-ignore lint/suspicious/noConsole: This module is the CLI output boundary.
export const step = (msg: string): void => console.log(`\n[${ts()}] ▸ ${msg}`);
// biome-ignore lint/suspicious/noConsole: This module is the CLI output boundary.
export const warn = (msg: string): void => console.warn(`[${ts()}] ! ${msg}`);
// biome-ignore lint/suspicious/noConsole: This module is the CLI output boundary.
export const fail = (msg: string): void => console.error(`[${ts()}] ✖ ${msg}`);
