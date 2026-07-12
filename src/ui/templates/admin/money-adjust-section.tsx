import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import { CsrfFormShell } from "#shared/forms.tsx";
import { ErrorNote } from "#templates/components/error.tsx";
import { PriceInput } from "#templates/components/price-input.tsx";

export const MoneyAdjustSection = ({
  action,
  className,
  currentLabel,
  currentValue,
  inputId,
  inputLabel,
  inputMin,
  inputName = inputId,
  link,
  submitLabel,
  title,
  warning,
}: {
  action: string;
  className?: string;
  currentLabel: string;
  currentValue: number;
  inputId: string;
  inputLabel: string;
  inputMin?: string;
  inputName?: string;
  link?: { href: string; label: string };
  submitLabel: string;
  title: string;
  warning: string;
}): JSX.Element => (
  <CsrfFormShell
    action={action}
    {...(className ? { class: className } : {})}
    submitLabel={submitLabel}
  >
    <h2>{title}</h2>
    <ErrorNote>{warning}</ErrorNote>
    <label>
      {currentLabel}
      <input disabled type="text" value={formatCurrency(currentValue)} />
    </label>
    <label for={inputId}>
      {inputLabel}
      <PriceInput
        id={inputId}
        {...(inputMin ? { min: inputMin } : {})}
        name={inputName}
        value={toMajorUnits(currentValue)}
      />
    </label>
    {link && (
      <p>
        <small>
          <a href={link.href}>{link.label}</a>
        </small>
      </p>
    )}
  </CsrfFormShell>
);
