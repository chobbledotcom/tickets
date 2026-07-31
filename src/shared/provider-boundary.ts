import * as v from "valibot";
import type { Money } from "#shared/payment-state/resources.ts";
import { isInstant } from "#shared/validation/timestamp.ts";

export const StringMapSchema = v.record(v.string(), v.string());

const unchanged = (value: string): string => value;

export const providerInstantSchema = (
  provider: string,
  normalize: (value: string) => string = unchanged,
): v.GenericSchema<string, string> =>
  v.pipe(
    v.string(),
    v.check(isInstant, `${provider} timestamp must be a real instant`),
    v.transform(normalize),
  );

export const sameMoney = (
  left: Pick<Money, "amount" | "currency">,
  right: Pick<Money, "amount" | "currency">,
): boolean => left.amount === right.amount && left.currency === right.currency;
