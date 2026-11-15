import { expect } from "@std/expect";

/** Assert a map keyed by record id holds each expected value. */
export const expectMapValues = <T>(
  map: ReadonlyMap<number, T>,
  expected: readonly (readonly [record: { id: number }, value: T])[],
): void => {
  for (const [record, value] of expected) {
    expect(map.get(record.id)).toBe(value);
  }
};
