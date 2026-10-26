export interface FormState {
  status: 'idle' | 'error' | 'success';
  message?: string;
}

export const initialFormState: FormState = { status: 'idle' };

/** Reads a single text field; File values and absent fields become undefined. */
export function fieldValue(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}
