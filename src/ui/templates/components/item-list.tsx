/**
 * A plain bullet list: one `<li>` per item, rendered by the caller's `render`.
 * The list shape shared by the settings nag banner and the drift notice.
 */

export const ItemList = <T,>({
  items,
  render,
}: {
  items: readonly T[];
  render: (item: T) => JSX.Element;
}): JSX.Element => (
  <ul>
    {items.map((item) => (
      <li>{render(item)}</li>
    ))}
  </ul>
);
