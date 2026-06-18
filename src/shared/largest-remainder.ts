type LargestRemainderOptions = {
  canReceive?: (index: number) => boolean;
  tieBreaker?: (index: number) => number;
};

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
