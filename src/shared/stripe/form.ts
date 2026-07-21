export type StripeFormValue =
  | boolean
  | number
  | string
  | null
  | undefined
  | readonly StripeFormValue[]
  | { readonly [key: string]: StripeFormValue };

const encodePart = (value: string): string =>
  encodeURIComponent(value)
    .replaceAll("!", "%21")
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("*", "%2A")
    .replaceAll("%5B", "[")
    .replaceAll("%5D", "]");

const formEntries = (
  key: string,
  value: StripeFormValue,
): readonly (readonly [string, string])[] => {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object") {
    return [[key, value === null ? "" : String(value)]];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      formEntries(`${key}[${index}]`, item),
    );
  }
  return Object.entries(value).flatMap(([childKey, childValue]) =>
    formEntries(`${key}[${childKey}]`, childValue),
  );
};

/** Encode Stripe v1 request data using its nested bracket format. */
export const encodeStripeForm = (
  data: Readonly<Record<string, StripeFormValue>>,
): string =>
  Object.entries(data)
    .flatMap(([key, value]) => formEntries(key, value))
    .map(([key, value]) => `${encodePart(key)}=${encodePart(value)}`)
    .join("&");
