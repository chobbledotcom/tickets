// effects: pure
/** A result that carries no fact beyond which outcome it is. */
export type KindOnly<Kind extends string> = { readonly kind: Kind };
