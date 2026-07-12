/**
 * Build a "find it, then use it" loader from a fetch function.
 *
 * The returned helper looks the record up by id and hands it to `build`. A
 * missing record skips `build` and gives back null — the expected "not found"
 * outcome the caller branches on, usually into a 404.
 */
/** A loader built by {@link findByIdThen}, fixed to one record type. */
export type FindByIdThen<R> = <T>(
  id: number,
  build: (record: R) => T | Promise<T>,
) => Promise<T | null>;

export const findByIdThen =
  <R>(fetch: (id: number) => Promise<R | null>): FindByIdThen<R> =>
  async (id, build) => {
    const record = await fetch(id);
    return record === null ? null : build(record);
  };
