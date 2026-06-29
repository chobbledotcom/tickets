type LargestRemainderOptions = {
  canReceive?: ((index: number) => boolean) | undefined;
  tieBreaker?: ((index: number) => number) | undefined;
};

type LargestRemainderAllocationOptions = {
  canReceive?: (index: number, floor: number) => boolean;
  tieBreaker?: (index: number) => number;
};

const sumNumbers = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0);

const largestRemainderIndexes = (
  shares: ReadonlyArray<number>,
  count: number,
  options: LargestRemainderOptions = {},
): Set<number> => {
  const canReceive = options.canReceive ?? (() => true);
  const tieBreaker = options.tieBreaker ?? ((index: number) => index);
  return new Set(
    shares
      .map((share, index) => ({
        index,
        remainder: share - Math.floor(share),
        tieBreaker: tieBreaker(index),
      }))
      .filter(({ index }) => canReceive(index))
      .sort((a, b) => b.remainder - a.remainder || a.tieBreaker - b.tieBreaker)
      .slice(0, count)
      .map(({ index }) => index),
  );
};

export const largestRemainderAllocation = (
  weights: ReadonlyArray<number>,
  amount: number,
  options: LargestRemainderAllocationOptions = {},
): number[] => {
  const total = sumNumbers(weights);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const shares = weights.map((weight) => (amount * weight) / total);
  const floors = shares.map((share) => Math.floor(share));
  const leftover = amount - sumNumbers(floors);
  const indexOptions: LargestRemainderOptions = {
    tieBreaker: options.tieBreaker,
  };
  if (options.canReceive) {
    indexOptions.canReceive = (index) =>
      options.canReceive!(index, floors[index]!);
  }
  const bumped = largestRemainderIndexes(shares, leftover, indexOptions);
  return floors.map((value, index) => value + (bumped.has(index) ? 1 : 0));
};
