export const TransactionHeader = ({
  icon,
  title,
}: {
  icon: React.ReactNode;
  title: string;
}) => (
  <div className="col-span-1 flex items-center gap-1">
    {icon}
    <span className="text-2xl text-foreground-primary">{title}</span>
  </div>
);
