import type { MoneyProps } from '../domain/money.js';

export interface WalletReconciliation {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export interface WalletReconciliationStore {
  readReconciliation(walletId: string): Promise<WalletReconciliation | null>;
}

export class ReconcileWallet {
  constructor(
    private readonly store: WalletReconciliationStore,
    private readonly recordDivergence: (walletId: string, checkedEntries: number) => void,
  ) {}

  async execute(walletId: string): Promise<WalletReconciliation | null> {
    const result = await this.store.readReconciliation(walletId);
    if (result && !result.consistent) this.recordDivergence(result.walletId, result.checkedEntries);
    return result;
  }
}
