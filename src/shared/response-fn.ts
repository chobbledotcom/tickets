/**
 * The shape of a step that turns one resolved value into a response — a
 * validated input written to the database, or an uploaded image handed on to
 * the next stage. Named once so the wrappers that take such a step agree.
 */

/** Take a resolved value and produce the response for it. */
export type ResponseFn<T> = (value: T) => Promise<Response>;
