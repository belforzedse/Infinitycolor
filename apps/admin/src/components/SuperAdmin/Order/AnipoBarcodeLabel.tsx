import FactorchiBarcode, {
  encodeFactorchiCode128B,
} from "@/components/FactorchiBarcode";

export type AnipoLabelProps = {
  packageNumber?: string;
  packageSize?: string;
  origin?: string;
  destination?: string;
  weight?: string;
  time?: string;
  date?: string;
  fare?: string;
  barcodeNumber?: string;
  recipientName?: string;
  recipientPhone?: string;
  recipientAddress?: string;
  postalCode?: string;
};

export default function AnipoBarcodeLabel(props: AnipoLabelProps) {
  const barcode = props.barcodeNumber?.trim() || "";
  const postalCode = props.postalCode?.trim();
  const printablePostalCode =
    postalCode && !/^[0۰٠]+$/.test(postalCode) ? postalCode : undefined;
  const encoded = encodeFactorchiCode128B(barcode);
  if (!encoded || encoded.value !== barcode)
    return <div className="anipo-loading">کد رهگیری معتبر نیست</div>;
  return (
    <article className="anipo-label" data-testid="anipo-shipping-label">
      <header className="anipo-header">
        <strong>برچسب پستی</strong>
        <span>آنیپو</span>
      </header>
      <section className="anipo-recipient-info">
        {props.recipientName && (
          <div>
            <strong>گیرنده: </strong>
            {props.recipientName}
          </div>
        )}
        {props.recipientPhone && (
          <div>
            <strong>شماره همراه: </strong>
            <span dir="ltr">{props.recipientPhone}</span>
          </div>
        )}
        {props.recipientAddress && (
          <div>
            <strong>نشانی: </strong>
            {props.recipientAddress}
          </div>
        )}
        {printablePostalCode && (
          <div>
            <strong>کدپستی: </strong>
            <span dir="ltr">{printablePostalCode}</span>
          </div>
        )}
      </section>
      <dl className="anipo-content">
        {props.destination && (
          <div>
            <dt>مقصد</dt>
            <dd>{props.destination}</dd>
          </div>
        )}
        {props.origin && (
          <div>
            <dt>مبدأ</dt>
            <dd>{props.origin}</dd>
          </div>
        )}
        {props.weight && (
          <div>
            <dt>وزن</dt>
            <dd>{props.weight}</dd>
          </div>
        )}
        {props.packageSize && (
          <div>
            <dt>جعبه</dt>
            <dd>{props.packageSize}</dd>
          </div>
        )}
        {props.date && (
          <div>
            <dt>تاریخ صدور</dt>
            <dd>
              {props.date}
              {props.time ? ` · ${props.time}` : ""}
            </dd>
          </div>
        )}
        {props.fare && (
          <div>
            <dt>کرایه پستی</dt>
            <dd>{props.fare}</dd>
          </div>
        )}
      </dl>
      <div className="anipo-barcode-section" dir="ltr">
        <div className="anipo-barcode-svg">
          <FactorchiBarcode value={barcode} height={70} />
        </div>
        <div className="anipo-barcode-number">{barcode}</div>
      </div>
    </article>
  );
}
