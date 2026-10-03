/** Keep the first answer a call produced and hand it back for the same input,
 * so a repeated input costs one computation. Inputs compare like Map keys do.
 * The keyed sibling of `#fp`'s `once`. */
export const remembered = <In, Out>(
  answer: (input: In) => Out,
): ((input: In) => Out) => {
  const answers = new Map<In, Out>();
  return (input) => {
    const known = answers.get(input);
    if (known !== undefined) return known;
    const fresh = answer(input);
    answers.set(input, fresh);
    return fresh;
  };
};
