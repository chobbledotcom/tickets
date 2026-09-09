/** Proxy an object while replacing selected members. Unchanged methods stay
 * bound to their original target, so native and SDK objects keep their receiver. */
export const proxyMembers = <T extends object>(
  target: T,
  overrides: object,
): T => {
  const onMember =
    <Args extends unknown[], Result>(
      operation: (
        object: object,
        property: PropertyKey,
        ...args: Args
      ) => Result,
    ) =>
    (inner: T, property: PropertyKey, ...args: Args): Result =>
      operation(
        Reflect.has(overrides, property) ? overrides : inner,
        property,
        ...args,
      );
  return new Proxy(target, {
    defineProperty: onMember(Reflect.defineProperty),
    get(inner, property) {
      if (Reflect.has(overrides, property)) {
        return Reflect.get(overrides, property);
      }
      const value = Reflect.get(inner, property);
      return typeof value === "function" ? value.bind(inner) : value;
    },
    getOwnPropertyDescriptor: onMember(Reflect.getOwnPropertyDescriptor),
    set: onMember((inner, property, value: unknown) =>
      Reflect.set(inner, property, value),
    ),
  });
};
