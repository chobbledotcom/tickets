/**
 * List rendering helpers: bare mapped lists and the `<li>` bullet flavor.
 */

/** Every item rendered through `render`, as a bare list with no wrapper
 * element — the shape a caller spreads inside its own fieldset or page. */
export const mappedItems = <T,>(
  items: readonly T[],
  render: (item: T) => JSX.Element,
): JSX.Element => <>{items.map(render)}</>;

/** A plain bullet list: one `<li>` per item, rendered by the caller's `render`.
 * The list shape shared by the settings nag banner and the drift notice. */
export const ItemList = <T,>({
  items,
  render,
}: {
  items: readonly T[];
  render: (item: T) => JSX.Element;
}): JSX.Element => (
  <ul>
    {mappedItems(items, (item) => (
      <li>{render(item)}</li>
    ))}
  </ul>
);
