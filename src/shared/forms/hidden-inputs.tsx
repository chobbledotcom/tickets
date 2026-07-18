export const hiddenInputs = (
  entries: readonly (readonly [string, string])[],
): JSX.Element[] =>
  entries.map(([name, value]) => (
    <input name={name} type="hidden" value={value} />
  ));
