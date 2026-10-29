import * as v from "valibot";
import { largestRemainderAllocation } from "#shared/largest-remainder.ts";
import {
  type TaxAssessment,
  type TaxBasis,
  TaxBasisSchema,
  type TaxPolicy,
  TaxPolicySchema,
} from "#shared/tax/types.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

/** The basis lines for the gross amounts keyed by listing: one line each. */
export const taxBasisLines = (
  grossByListing: ReadonlyMap<number, number>,
): TaxBasis["lines"] =>
  [...grossByListing].map(([listingId, gross]) => ({ gross, listingId }));

const MinorUnitsSchema = integerAtLeast(0);
const minorUnits = (value: bigint): number =>
  v.parse(MinorUnitsSchema, Number(value));
const sum = (amounts: readonly number[]): bigint =>
  amounts.reduce((total, amount) => total + BigInt(amount), 0n);
const roundedRatio = (
  amount: number,
  numerator: number,
  denominator: bigint,
): number =>
  minorUnits(
    (BigInt(amount) * BigInt(numerator) * 2n + denominator) /
      (denominator * 2n),
  );

/** The fixed listed basis excludes booking fees, payments and write-offs. */
export const assessTax = (
  basis: TaxBasis,
  policy: TaxPolicy,
): TaxAssessment => {
  v.parse(TaxBasisSchema, basis);
  v.parse(TaxPolicySchema, policy);
  const taxableTotal = minorUnits(
    sum(basis.lines.map((line) => line.gross)) +
      sum(basis.modifiers.map((modifier) => modifier.delta)),
  );
  const taxAmount =
    policy.mode === "none"
      ? 0
      : roundedRatio(
          taxableTotal,
          policy.rateBasisPoints,
          policy.mode === "add_to_total"
            ? 10000n
            : 10000n + BigInt(policy.rateBasisPoints),
        );
  const included = policy.mode === "calculate_from_total";
  const weights = [
    ...basis.lines.map((line) => line.gross),
    ...basis.modifiers.map((modifier) => Math.max(0, modifier.delta)),
  ];
  const shares = largestRemainderAllocation(weights, included ? taxAmount : 0);
  return {
    basis,
    lines: basis.lines.map((line, index) => ({
      ...line,
      gross: line.gross - shares[index]!,
    })),
    modifiers: basis.modifiers.map((modifier, index) => ({
      ...modifier,
      delta:
        modifier.delta > 0
          ? modifier.delta - shares[basis.lines.length + index]!
          : modifier.delta,
    })),
    policy,
    taxAmount,
    taxableTotal,
    total: minorUnits(
      BigInt(taxableTotal) +
        BigInt(policy.mode === "add_to_total" ? taxAmount : 0),
    ),
  };
};
