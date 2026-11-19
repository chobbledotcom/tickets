/**
 * The row and input shapes of a minimal `{ id, name }` record, so the REST
 * test suites share one shape rather than each declaring it again. The
 * logistics agents table stores this shape.
 */

export type IdNameRow = { id: number; name: string };
export type IdNameInput = { name: string };
