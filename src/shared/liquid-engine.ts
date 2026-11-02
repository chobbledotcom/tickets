import { Liquid } from "liquidjs";
import { lazyRef } from "#fp";
import { formatCurrency } from "#shared/currency.ts";

/** Create a Liquid engine with the application's shared filters. Pass
 * `outputEscape: "escape"` where the output is HTML, so every `{{ }}`
 * interpolation of user data renders HTML-escaped while template markup stays
 * intact. */
export const createBaseLiquidEngine = (
  options: { outputEscape?: "escape" | undefined } = {},
): Liquid => {
  // The key must be absent when unset: liquidjs rejects an explicit
  // `outputEscape: undefined`.
  const escaping =
    options.outputEscape === undefined
      ? {}
      : { outputEscape: options.outputEscape };
  const engine = new Liquid({
    ...escaping,
    strictFilters: true,
    strictVariables: false,
  });
  engine.registerFilter("currency", (value: string | number) =>
    formatCurrency(value),
  );
  engine.registerFilter(
    "pluralize",
    (count: number, singular: string, plural: string) =>
      count === 1 ? singular : plural,
  );
  if (escaping.outputEscape) {
    // `raw` hands the value through unescaped, undoing the escape mode.
    delete engine.filters.raw;
  }
  return engine;
};

/** The one plain engine for a template that outputs text or trusted markup.
 * A cold start builds it on first use. */
const [getPlainEngine, setPlainEngine] = lazyRef<Liquid>(() =>
  createBaseLiquidEngine(),
);

/** The one HTML engine for a template whose output is HTML built from values
 * a person typed. Every interpolation is escaped. */
const [getHtmlEngine, setHtmlEngine] = lazyRef<Liquid>(() =>
  createBaseLiquidEngine({ outputEscape: "escape" }),
);

export const plainLiquidEngine = (): Liquid => getPlainEngine();

export const htmlLiquidEngine = (): Liquid => getHtmlEngine();

/** For testing: drop the cached engines, so a changed currency setting
 * registers its filters afresh. */
export const resetLiquidEngines = (): void => {
  setPlainEngine(null);
  setHtmlEngine(null);
};
