import * as v from "valibot";
import { guardFor } from "#shared/validation/guard.ts";

/**
 * Shared string value types.
 *
 * TypeScript cannot prove that an arbitrary runtime `string` is non-empty, so
 * callers that need that invariant should carry this branded type instead. The
 * only production paths into the brand are the helpers below, which validate at
 * the boundary and let downstream code avoid repeated empty-string checks.
 */
export const NonEmptyTextSchema = v.pipe(v.string(), v.nonEmpty());
export const NonEmptyStringSchema = v.pipe(
  NonEmptyTextSchema,
  v.brand("NonEmptyString"),
);
export const OptionalStringSchema = v.optional(v.string());
export const UrlSchema = v.pipe(v.string(), v.url());

/** A piece of text that may be left out, but has to pass the test when it is
 *  there. */
type OptionalCheckedString = v.OptionalSchema<
  v.SchemaWithPipe<
    readonly [
      v.StringSchema<undefined>,
      v.CheckAction<string, string | undefined>,
    ]
  >,
  undefined
>;

export const optionalStringThat = (
  passes: (value: string) => boolean,
  message?: string,
): OptionalCheckedString =>
  v.optional(v.pipe(v.string(), v.check(passes, message)));

export type NonEmptyString = v.InferOutput<typeof NonEmptyStringSchema>;
type NonEmptyLiteral<T extends string> = T extends "" ? never : T;

export const isNonEmptyString = guardFor(NonEmptyStringSchema);

export const parseNonEmptyString = (value: string): NonEmptyString | null => {
  const result = v.safeParse(NonEmptyStringSchema, value);
  return result.success ? result.output : null;
};

export const nonEmptyString = <T extends string>(
  value: NonEmptyLiteral<T>,
  name = "value",
): NonEmptyString & T => {
  const parsed = parseNonEmptyString(value as string);
  if (parsed === null) throw new Error(`${name} must be non-empty`);
  return parsed as NonEmptyString & T;
};
