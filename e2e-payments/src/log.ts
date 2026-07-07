/** Tiny timestamped logger. Never pass secrets to these. */

const _ts = (): string => new Date().toISOString().slice(11, 23);

export const log = (_msg: string): void => {};
export const step = (_msg: string): void => {};
export const warn = (_msg: string): void => {};
export const fail = (_msg: string): void => {};
