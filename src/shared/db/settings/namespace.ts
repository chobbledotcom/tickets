/**
 * Assembly of the `settings` namespace from its separate parts.
 *
 * Each part contributes getters, so the parts merge by property descriptor. A
 * spread calls every getter once, at assembly time, and freezes the answer
 * it returned then.
 */

import {
  type SettingsData,
  type StringSettingKey,
  snap,
} from "#db/settings/snapshot.ts";

/** Copy `props` onto `target`, so that a getter stays a getter. */
export const withProperties = <T extends object, P extends object>(
  target: T,
  props: P,
): T & P => {
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(props));
  return target as T & P;
};

/** Snapshot keys whose stored value is a plain string, so a value guard can
 *  read it. Sealed fields are out: their stored value is still ciphertext. */
type PlainStringKey = {
  [K in keyof SettingsData]: SettingsData[K] extends string ? K : never;
}[keyof SettingsData];

/** A known-value read: the field, its value guard, and the fallback for a
 *  value the guard does not know. */
type KnownSpec<TValue extends string> = {
  key: PlainStringKey;
  isKnown: (candidate: string) => candidate is TValue;
  fallback: TValue;
};

/** One stored-setting getter. A plain read returns the field as its own
 *  type. {@link isSet} answers whether the field is set. {@link known}
 *  keeps only a value we know. */
type StoredSettingSpec =
  | keyof SettingsData
  | { isSet: StringSettingKey }
  | { known: KnownSpec<string> };

/** The getter type for one spec. A plain read returns the field's own type.
 *  An is-set entry is a boolean. A known entry has the guard's type. */
type GetterFor<Spec extends StoredSettingSpec> = Spec extends {
  isSet: StringSettingKey;
}
  ? boolean
  : Spec extends { known: KnownSpec<infer TValue> }
    ? TValue
    : Spec extends keyof SettingsData
      ? SettingsData[Spec]
      : never;

/** Mark a stored string setting as an is-set getter: true unless the stored
 *  value is the empty string. */
export const isSet = <K extends StringSettingKey>(key: K): { isSet: K } => ({
  isSet: key,
});

/** Mark a stored setting as a known-value getter: the guard's type when the
 *  stored value is one it knows, the fallback otherwise. The const type
 *  parameter keeps the fallback literal, so the guard's type wins. */
export const known = <const TValue extends string>(
  parts: KnownSpec<TValue>,
): { known: KnownSpec<TValue> } => ({ known: parts });

/** Live getters for stored settings: one per name, built with defineProperty
 *  so a getter survives every later merge. */
export const snapGetters = <T extends Record<string, StoredSettingSpec>>(
  fields: T,
): { [N in keyof T]: GetterFor<T[N]> } => {
  const getters = {} as { [N in keyof T]: GetterFor<T[N]> };
  for (const [name, spec] of Object.entries(fields)) {
    Object.defineProperty(getters, name, {
      enumerable: true,
      get: () => {
        if (typeof spec === "string") return snap(spec);
        if ("isSet" in spec) return snap(spec.isSet) !== "";
        const stored = snap(spec.known.key);
        return spec.known.isKnown(stored) ? stored : spec.known.fallback;
      },
    });
  }
  return getters;
};
