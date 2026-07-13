/** A value that may be delivered synchronously or as a promise — the shared
 * spelling for handler return types that can be sync or async. */
export type MaybePromise<T> = T | Promise<T>;
