import { Liquid } from "liquidjs";
import { formatCurrency } from "#shared/currency.ts";

/** Create a Liquid engine with the application's shared filters. */
export const createBaseLiquidEngine = (): Liquid => {
  const engine = new Liquid({ strictFilters: true, strictVariables: false });
  engine.registerFilter("currency", (value: string | number) =>
    formatCurrency(value),
  );
  return engine;
};
