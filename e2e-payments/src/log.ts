/** Tiny timestamped logger. Never pass secrets to these. */

const ts = (): string => new Date().toISOString().slice(11, 23);

export const log = (msg: string): void => console.log(`[${ts()}] ${msg}`);
export const step = (msg: string): void => console.log(`\n[${ts()}] ▸ ${msg}`);
export const warn = (msg: string): void => console.warn(`[${ts()}] ! ${msg}`);
export const fail = (msg: string): void => console.error(`[${ts()}] ✖ ${msg}`);
