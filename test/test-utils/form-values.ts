import { FormParams } from "#shared/form-data.ts";

export type TestFormValues = Record<
  string,
  string | string[] | null | undefined
>;

export const appendTestFormValues = (
  params: URLSearchParams | FormData,
  data: TestFormValues = {},
): void => {
  for (const [key, values] of Object.entries(data)) {
    if (values == null) continue;
    for (const value of typeof values === "string" ? [values] : values) {
      params.append(key, value);
    }
  }
};

export const testFormParams = (data: TestFormValues): FormParams => {
  const params = new FormParams();
  appendTestFormValues(params, data);
  return params;
};
