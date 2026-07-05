import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import { CsrfForm } from "#shared/forms.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
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
  <CsrfForm action={action} {...(className ? { class: className } : {})}>
    <h2>{title}</h2>
    <div class="error" role="alert">
      {warning}
    </div>
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
    <SubmitButton icon="save">{submitLabel}</SubmitButton>
  </CsrfForm>
);
