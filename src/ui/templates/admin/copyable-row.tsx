export type CopyableInputRowSpec = {
  className?: string;
  id: string;
  label: string;
  value: string;
};

export const CopyableInputRow = ({
  className,
  id,
  label,
  value,
}: CopyableInputRowSpec): JSX.Element => (
  <tr class={className}>
    <th>
      <label for={id}>{label}</label>
    </th>
    <td>
      <input data-select-on-click id={id} readonly type="text" value={value} />
    </td>
  </tr>
);
