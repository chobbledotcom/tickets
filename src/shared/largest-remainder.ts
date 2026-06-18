type LargestRemainderOptions = {
  canReceive?: (index: number) => boolean;
  tieBreaker?: (index: number) => number;
};

type LargestRemainderAllocationOptions = {
  canReceive?: (index: number, floor: number) => boolean;
  tieBreaker?: (index: number) => number;
};

const sumNumbers = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0);

export const largestRemainderIndexes = (
  shares: ReadonlyArray<number>,
  count: number,
  {
    canReceive = () => true,
    tieBreaker = (index) => index,
  }: LargestRemainderOptions = {},
): Set<number> =>
  new Set(
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
  const bumped = largestRemainderIndexes(shares, leftover, {
    canReceive: (index) => options.canReceive?.(index, floors[index]!) ?? true,
    tieBreaker: options.tieBreaker,
  });
  return floors.map((value, index) => value + (bumped.has(index) ? 1 : 0));
};
