/**
 * Assembly of the `settings` namespace from its separate parts.
 *
 * Each part contributes getters, so the parts merge by property descriptor. A
 * spread would call every getter once, at assembly time, and freeze the answer
 * it returned then.
 */

/** Copy `props` onto `target`, so that a getter stays a getter. */
export const withProperties = <T extends object, P extends object>(
  target: T,
  props: P,
): T & P => {
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(props));
  return target as T & P;
};
