import type {
  ExtraLine,
  PricedLine,
  PricedOrder,
} from "#shared/checkout-pricing.ts";

/** Render ticket and extra charges in the same order for every provider. */
export const buildProviderLineItems = <Item>(
  order: PricedOrder,
  currency: string,
  render: {
    line: (line: PricedLine, currency: string) => Item;
    extra: (extra: ExtraLine, currency: string) => Item;
  },
): Item[] => [
  ...order.lines.map((line) => render.line(line, currency)),
  ...order.extras.map((extra) => render.extra(extra, currency)),
];
