/**
 * A stand-in that carries only the members a test reads. Each member must fit
 * the real type, so a renamed or retyped member breaks the test at compile
 * time. The one cast is the contained cost of leaving the other members out.
 */
export const partialFake = <T extends object>(parts: Partial<T>): T =>
  parts as T;
