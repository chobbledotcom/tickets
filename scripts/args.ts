export type ArgumentStep = (arg: string, index: number) => number | undefined;

type UseFlagValue = (value: string | undefined) => void;

/** If `arg` is `flag`, consume `args[index + 1]` as its value (returning 2 so
 * the walk skips both tokens); otherwise return null so the caller can try a
 * different reading of this arg. */
export const consumeFlagValue = (
  args: readonly string[],
  arg: string,
  index: number,
  flag: string,
  useValue: UseFlagValue,
): number | null => {
  if (arg === flag) {
    useValue(args[index + 1]);
    return 2;
  }

  return null;
};

/** Walk command arguments. Return 2 when a flag also uses its value. */
export const walkArguments = (
  args: readonly string[],
  step: ArgumentStep,
): void => {
  for (let index = 0; index < args.length; ) {
    index += step(args[index]!, index) ?? 1;
  }
};
