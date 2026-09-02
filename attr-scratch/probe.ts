type Counter = (n: number) => number;

const makeCounter = (): Counter => {
  const seen = new Map<number, number>();
  return (n: number): number => {
    const cached = seen.get(n);
    if (cached) return cached;
    const doubled = n * 2;
    seen.set(n, doubled);
    return doubled;
  };
};

const counter = makeCounter();

const withDefault = (opts: { tag?: string } = {}): string => {
  const tag = opts.tag ?? "none";
  if (!tag) return "empty";
  return tag.toUpperCase();
};

type Holder = { declarations?: unknown[] };

const namesOf = (target: Holder): unknown[] =>
  (target.declarations ?? []).filter((d: unknown): boolean =>
    typeof d === "string" && d.length > 0
  );

const callbacks = (visitor: (n: number) => void): void => {
  [1, 2].forEach((n: number): void => {
    const which = n === 1 ? "first" : "later";
    if (which === "later") return;
    visitor(n);
  });
};

export const runAll = (): { a: number; b: string; c: unknown[]; d: number } => {
  let visitedByCallback = 0;
  callbacks(() => {
    visitedByCallback = 1;
  });
  return {
    a: counter(1) + counter(1) + counter(3),
    b: withDefault() + withDefault({ tag: "x" }),
    c: namesOf({ declarations: ["a", 1, ""] }) && namesOf({}),
    d: visitedByCallback,
  };
};
