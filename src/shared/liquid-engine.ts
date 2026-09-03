import { Liquid } from "liquidjs";
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
  return engine;
};
