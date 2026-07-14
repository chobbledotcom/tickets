/** Proxy an object while replacing selected members. Unchanged methods stay
 * bound to their original target, so native and SDK objects keep their receiver. */
export const proxyMembers = <T extends object>(
  target: T,
  overrides: object,
): T =>
  new Proxy(target, {
    defineProperty(inner, property, attributes) {
      return Reflect.has(overrides, property)
        ? Reflect.defineProperty(overrides, property, attributes)
        : Reflect.defineProperty(inner, property, attributes);
    },
    get(inner, property, receiver) {
      if (Reflect.has(overrides, property)) {
        return Reflect.get(overrides, property);
      }
      const value = Reflect.get(inner, property, receiver);
      return typeof value === "function" ? value.bind(inner) : value;
    },
    getOwnPropertyDescriptor(inner, property) {
      return Reflect.has(overrides, property)
        ? Reflect.getOwnPropertyDescriptor(overrides, property)
        : Reflect.getOwnPropertyDescriptor(inner, property);
    },
    set(inner, property, value, receiver) {
      return Reflect.has(overrides, property)
        ? Reflect.set(overrides, property, value)
        : Reflect.set(inner, property, value, receiver);
    },
  });
