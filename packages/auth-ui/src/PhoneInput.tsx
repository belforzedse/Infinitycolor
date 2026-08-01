import AuthInput from "./Input";
import EditIcon from "./icons/EditIcon";

export interface PhoneInputProps {
  value: string;
  onEdit: () => void;
  id?: string;
  name?: string;
  autoComplete?: string;
}

export default function PhoneInput({
  value,
  onEdit,
  id,
  name,
  autoComplete,
}: PhoneInputProps) {
  const editButton = (
    <button
      type="button"
      onClick={onEdit}
      className="flex flex-row-reverse items-center gap-1 rounded bg-sky-600 px-2 py-1 text-white transition-colors hover:bg-sky-700"
    >
      <span className="text-sm">ویرایش</span>
      <EditIcon className="h-4 w-4" />
    </button>
  );

  // Convert English numbers to Persian
  const faValue = value.replace(
    /\d/g,
    (d) => ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"][Number(d)],
  );

  return (
    <AuthInput
      id={id}
      name={name}
      type="tel"
      value={faValue}
      readOnly
      autoComplete={autoComplete}
      className="border-slate-200 bg-slate-100"
      dir="ltr"
      rightElement={editButton}
    />
  );
}
