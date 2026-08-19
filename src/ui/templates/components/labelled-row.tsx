import type { Child } from "#jsx/jsx-runtime.ts";

/** One row of a details table: a heading cell for the label, then the value
 * beside it. */
export const LabelledRow = ({
  label,
  children,
}: {
  label: Child;
  children?: Child;
}): JSX.Element => (
  <tr>
    <th>{label}</th>
    <td>{children}</td>
  </tr>
);
