import { parsePositiveInt } from "#shared/validation/number.ts";

const DEFAULT_PORT = 12111;

/** Read the optional stripe-mock port without accepting partial numbers. */
const port = (value: string | undefined): number => {
  if (value === undefined) return DEFAULT_PORT;
  const parsed = parsePositiveInt(value);
  if (parsed === null || parsed > 65_535) {
    throw new Error("STRIPE_MOCK_PORT must be a number from 1 to 65535");
  }
  return parsed;
};

/** Shared stripe-mock defaults and strict environment parsing. */
export const stripeMock = { defaultPort: DEFAULT_PORT, port };
