import tokensConfig from "./tokens.yaml";

/** One deployable order — maps directly to a single registry.getGui() call. */
export interface OrderConfig {
  /** Human-readable label shown in the UI card header, e.g. "Buy GOOG" */
  label: string;
  /** Optional subtitle shown beneath the label */
  description?: string;
  /** Key passed to registry.getGui() — matches the .rain file name, e.g. "fixed-spread" */
  strategyType: string;
  /** Deployment key within that strategy file, e.g. "base-pyth-inv" */
  deploymentKey: string;
  /** { guiTokenKey: "0xAddress" } — passed to gui.setSelectToken() */
  selectTokens: Record<string, string>;
  /** { bindingName: "value" } — passed to gui.setFieldValue() */
  fieldValues: Record<string, string>;
  /** { guiTokenKey: "humanAmount" } — passed to gui.setDeposit(); "0" entries are skipped */
  deposits: Record<string, string>;
  /**
   * Optional vault IDs (Rain "word IDs") to set on the GUI before deployment.
   * Outer key: "input" | "output" (io direction). Inner key: token key from selectTokens.
   * When set, orders from the same strategy pair share vaults — deposited tokens
   * are immediately available across buy and sell orders.
   * Example: { input: { input: "0x0000...0002" }, output: { output: "0x0000...0001" } }
   */
  vaultIds?: Record<string, Record<string, string>>;
}

export interface StrategyConfig {
  name: string;
  orders: OrderConfig[];
}

const raw = tokensConfig as {
  registryCommit: string;
  strategies: StrategyConfig[];
};

export const REGISTRY_COMMIT: string = raw.registryCommit;
export const STRATEGIES: StrategyConfig[] = raw.strategies;
