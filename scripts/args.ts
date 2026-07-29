export type ArgumentStep = (arg: string, index: number) => number | undefined;

interface FlagValueOptions {
  readonly equals?: boolean;
}

type UseFlagValue = (value: string | undefined) => void;

export const consumeFlagValue = (
  args: readonly string[],
  arg: string,
  index: number,
  flag: string,
  useValue: UseFlagValue,
  options: FlagValueOptions = {},
): number | null => {
  if (arg === flag) {
    useValue(args[index + 1]);
    return 2;
  }

  if (options.equals === true && arg.startsWith(`${flag}=`)) {
    useValue(arg.slice(`${flag}=`.length));
    return 1;
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
