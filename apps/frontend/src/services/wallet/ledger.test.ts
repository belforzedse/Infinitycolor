import { splitWalletLedger, toWalletLedgerEntries } from "./ledger";

describe("toWalletLedgerEntries", () => {
  it("reads Type from a content-API attributes wrapper", () => {
    const entries = toWalletLedgerEntries([
      {
        id: 1,
        attributes: {
          Amount: "100000",
          Type: "Add",
          Date: "2026-09-18T10:00:00.000Z",
        },
      },
      {
        id: 2,
        attributes: {
          Amount: 50000,
          Type: "Minus",
          Date: "2026-09-19T10:00:00.000Z",
        },
      },
    ]);

    expect(entries).toEqual([
      {
        id: 1,
        amountIrr: 100000,
        type: "Add",
        date: "2026-09-18T10:00:00.000Z",
        cause: undefined,
        referenceId: undefined,
        note: undefined,
      },
      {
        id: 2,
        amountIrr: 50000,
        type: "Minus",
        date: "2026-09-19T10:00:00.000Z",
        cause: undefined,
        referenceId: undefined,
        note: undefined,
      },
    ]);
  });

  it("reads Type from a flat owner-ledger row", () => {
    const entries = toWalletLedgerEntries([
      { id: 9, Amount: 200000, Type: "Add", Date: "2026-09-20T00:00:00.000Z" },
    ]);

    expect(entries).toEqual([
      expect.objectContaining({ id: 9, amountIrr: 200000, type: "Add" }),
    ]);
  });

  it("drops rows whose Type is missing rather than showing an empty ledger", () => {
    expect(
      toWalletLedgerEntries([{ id: 1, Amount: 1000, Date: "2026-09-20T00:00:00.000Z" }]),
    ).toEqual([]);
  });
});

describe("splitWalletLedger", () => {
  it("separates deposits from purchases in toman", () => {
    const { deposits, purchases } = splitWalletLedger([
      {
        id: 1,
        amountIrr: 1_000_000,
        type: "Add",
        date: "2026-09-18T10:00:00.000Z",
      },
      {
        id: 2,
        amountIrr: 250_000,
        type: "Minus",
        date: "2026-09-19T10:00:00.000Z",
      },
    ]);

    expect(deposits).toEqual([{ date: "2026-09-18", amountToman: 100_000 }]);
    expect(purchases).toEqual([{ date: "2026-09-19", amountToman: 25_000 }]);
  });
});
