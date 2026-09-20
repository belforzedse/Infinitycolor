import React from "react";
import DepositIcon from "../Icons/DepositIcon";
import DebitIcon from "../Icons/DebitIcon";
import { TransactionSection } from "./TransactionSection";
import type { WalletLedgerUiRow } from "@/services/wallet/ledger";

interface TransactionsListProps {
  depositList: WalletLedgerUiRow[];
  purchaseList: WalletLedgerUiRow[];
}

const TransactionsList = ({ depositList, purchaseList }: TransactionsListProps) => {
  return (
    <div className="grid w-full gap-4 rounded-xl border border-slate-100 bg-white lg:grid-cols-2 lg:p-5">
      <TransactionSection
        title="واریز"
        icon={<DepositIcon />}
        transactions={depositList}
        type="deposit"
      />
      <TransactionSection
        title="برداشت"
        icon={<DebitIcon />}
        transactions={purchaseList}
        type="debit"
      />
    </div>
  );
};

export default TransactionsList;
