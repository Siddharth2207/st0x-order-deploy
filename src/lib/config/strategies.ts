/**
 * Strategy configuration for fixed-spread order deployment.
 *
 * Each entry defines one asset pair to trade against USDC.
 * The app will deploy two orders per entry:
 *   - BUY:  buy the asset with USDC (deployment key: base-pyth-inv)
 *   - SELL: sell the asset for USDC (deployment key: base-pyth)
 *
 * Edit this file to add/remove strategies or change parameters.
 */

export interface TokenConfig {
	address: string;
	symbol: string;
	decimals: number;
}

export interface StrategyConfig {
	/** Human-readable label, e.g. "GOOG/USDC" */
	name: string;

	/** Raindex network slug (must match settings.yaml) */
	network: 'base' | 'polygon' | 'arbitrum';

	/** Chain ID matching the network above */
	chainId: number;

	/** The "input" token that the order receives — typically USDC */
	inputToken: TokenConfig;

	/** The "output" token that the order sells — typically the synthetic asset */
	outputToken: TokenConfig;

	/**
	 * Pyth price feed ID (32-byte hex).
	 * The feed should quote outputToken/inputToken (e.g. GOOG/USD).
	 */
	pythFeedId: string;

	/**
	 * WAD multiplier applied on top of the oracle price.
	 * 1.001 means 0.1% spread above oracle for sells; below for buys.
	 */
	baselineMultiplier: string;

	/**
	 * Maximum age (in seconds) of an acceptable Pyth price.
	 * Older prices will cause the order to revert.
	 */
	oraclePriceTimeout: string;

	/**
	 * USDC amount to deposit into the BUY order vault (human-readable, e.g. "100").
	 * The buy order outputs USDC, so this seeds the buy side.
	 */
	depositInputAmount: string;

	/**
	 * Asset amount to deposit into the SELL order vault (human-readable, e.g. "1").
	 * The sell order outputs the asset, so this seeds the sell side.
	 * Set to "0" if you want to deploy without an initial deposit.
	 */
	depositOutputAmount: string;
}

// ---------------------------------------------------------------------------
// Base Mainnet token addresses
// ---------------------------------------------------------------------------

const BASE_USDC: TokenConfig = {
	address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
	symbol: 'USDC',
	decimals: 6
};

// Add your synthetic/wrapped asset addresses here.
// These are example addresses — replace with actual deployed token addresses.
const BASE_GOOG: TokenConfig = {
	address: '0x0000000000000000000000000000000000000000', // TODO: replace
	symbol: 'GOOG',
	decimals: 18
};

const BASE_AAPL: TokenConfig = {
	address: '0x0000000000000000000000000000000000000000', // TODO: replace
	symbol: 'AAPL',
	decimals: 18
};

// ---------------------------------------------------------------------------
// Pyth feed IDs (32-byte hex encoded)
// ---------------------------------------------------------------------------

const PYTH_FEEDS = {
	// Equity.US.GOOG/USD
	GOOG_USD: '0x924571756974792e55532e474f4f472f55534400000000000000000000000000',
	// Equity.US.AAPL/USD
	AAPL_USD: '0x924571756974792e55532e4141504c2f55534400000000000000000000000000',
	// Equity.US.MSFT/USD
	MSFT_USD: '0x924571756974792e55532e4d5346542f55534400000000000000000000000000',
	// Equity.US.TSLA/USD
	TSLA_USD: '0x924571756974792e55532e54534c412f55534400000000000000000000000000',
	// Equity.US.NVDA/USD
	NVDA_USD: '0x924571756974792e55532e4e5644412f55534400000000000000000000000000'
} as const;

// ---------------------------------------------------------------------------
// Strategy definitions — edit this array to configure deployments
// ---------------------------------------------------------------------------

export const STRATEGIES: StrategyConfig[] = [
	{
		name: 'GOOG/USDC',
		network: 'base',
		chainId: 8453,
		inputToken: BASE_USDC,
		outputToken: BASE_GOOG,
		pythFeedId: PYTH_FEEDS.GOOG_USD,
		baselineMultiplier: '1.001',
		oraclePriceTimeout: '300',
		depositInputAmount: '100', // 100 USDC for buy orders
		depositOutputAmount: '0' // set to e.g. "1" once you have the asset
	},
	{
		name: 'AAPL/USDC',
		network: 'base',
		chainId: 8453,
		inputToken: BASE_USDC,
		outputToken: BASE_AAPL,
		pythFeedId: PYTH_FEEDS.AAPL_USD,
		baselineMultiplier: '1.001',
		oraclePriceTimeout: '300',
		depositInputAmount: '100',
		depositOutputAmount: '0'
	}
];
