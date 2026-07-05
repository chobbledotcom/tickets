export const times =
  (count: number) =>
  <T>(factory: (index: number) => T): T[] =>
    Array.from({ length: count }, (_, index) => factory(index));
