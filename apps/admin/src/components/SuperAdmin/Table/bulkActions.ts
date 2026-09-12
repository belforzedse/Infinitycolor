/**
 * Bulk-action descriptors for SuperAdminTable.
 *
 * The option type used to be an inline `{ id, title }`, which left every page to
 * hand-roll its own confirmation state and gave destructive actions exactly the
 * same appearance as harmless ones. Both new fields are optional, so existing
 * `{ id, title }` arrays still satisfy the type.
 */

export type BulkActionConfirmInput = {
  label: string;
  type: "text" | "number";
  placeholder?: string;
  defaultValue?: string;
  min?: number;
  /** Returns a Persian error, or null when the value is acceptable. */
  validate?: (value: string) => string | null;
};

export type BulkActionConfirm = {
  title?: string;
  /** A function receives the number of selected rows. */
  description?: string | ((count: number) => string);
  confirmText?: string;
  cancelText?: string;
  /** Renders a field inside the dialog; its value arrives as `ctx.input`. */
  input?: BulkActionConfirmInput;
};

export type BulkActionOption = {
  id: string;
  title: string;
  /** "danger" styles the confirm button as destructive. */
  variant?: "default" | "danger";
  disabled?: boolean;
  /** Shown under the title in the menu; also serves as the disabled reason. */
  description?: string;
  confirm?: boolean | BulkActionConfirm;
};

export type BulkActionContext = {
  /** Present only for actions whose `confirm.input` was configured. */
  input?: string;
};

/** Normalises the `confirm` shorthand into an object, or null when not required. */
export function resolveBulkConfirm(
  option: BulkActionOption,
): BulkActionConfirm | null {
  if (!option.confirm) return null;
  return option.confirm === true ? {} : option.confirm;
}

export function bulkConfirmDescription(
  confirm: BulkActionConfirm,
  count: number,
): string | undefined {
  const { description } = confirm;
  return typeof description === "function" ? description(count) : description;
}
