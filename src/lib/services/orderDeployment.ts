/**
 * Fixed-spread order deployment service.
 *
 * Builds DotrainOrderGui instances for buy and sell sides of a fixed-spread
 * strategy and returns the raw DeploymentTransactionArgs ready to be sent
 * to either an EOA wallet or a SAFE.
 */

import { DotrainRegistry } from '@rainlanguage/orderbook';
import type { DeploymentTransactionArgs } from '@rainlanguage/orderbook';
import type { StrategyConfig } from '$lib/config/strategies';

// Pinned to the commit used in the main st0x app.
const RAIN_STRATEGIES_COMMIT = '2c8192e9137736507041ebff820b0e7b5b29f0d2';
const REGISTRY_URL = `https://raw.githubusercontent.com/rainlanguage/rain.strategies/${RAIN_STRATEGIES_COMMIT}/registry`;

let registryPromise: Promise<DotrainRegistry> | null = null;

async function getRegistry(): Promise<DotrainRegistry> {
	if (!registryPromise) {
		registryPromise = (async () => {
			const result = await DotrainRegistry.new(REGISTRY_URL);
			if (result.error) {
				registryPromise = null;
				throw new Error(result.error.readableMsg);
			}
			return result.value;
		})();
	}
	return registryPromise;
}

export type OrderSide = 'buy' | 'sell';

export interface DeploymentResult {
	side: OrderSide;
	composedRainlang: string;
	args: DeploymentTransactionArgs;
}

/**
 * Build deployment args for one side (buy or sell) of a fixed-spread strategy.
 *
 * Buy order:
 *   - deployment: base-pyth-inv (inverted price: USDC/asset)
 *   - output token: USDC (the order sells USDC to acquire the asset)
 *   - input token: asset (what the order receives)
 *   - deposit: USDC
 *
 * Sell order:
 *   - deployment: base-pyth (normal price: asset/USDC)
 *   - output token: asset (the order sells the asset)
 *   - input token: USDC (what the order receives)
 *   - deposit: asset
 */
export async function buildOrderDeployment(
	strategy: StrategyConfig,
	side: OrderSide,
	ownerAddress: string
): Promise<DeploymentResult> {
	const registry = await getRegistry();

	// fixed-spread has two deployments:
	//   base-pyth     → normal price feed, suitable for sell side (asset → USDC)
	//   base-pyth-inv → inverted price feed, suitable for buy side (USDC → asset)
	const deploymentKey = side === 'sell' ? 'base-pyth' : 'base-pyth-inv';

	const guiResult = await registry.getGui('fixed-spread', deploymentKey);
	if (guiResult.error) throw new Error(guiResult.error.readableMsg);
	const gui = guiResult.value;

	if (side === 'sell') {
		// Sell: output = asset, input = USDC
		await gui.setSelectToken('output', strategy.outputToken.address);
		await gui.setSelectToken('input', strategy.inputToken.address);
		if (strategy.depositOutputAmount !== '0') {
			gui.setDeposit('output', strategy.depositOutputAmount);
		}
	} else {
		// Buy: output = USDC (order sells USDC, receives asset), input = asset
		await gui.setSelectToken('output', strategy.inputToken.address);
		await gui.setSelectToken('input', strategy.outputToken.address);
		if (strategy.depositInputAmount !== '0') {
			gui.setDeposit('output', strategy.depositInputAmount);
		}
	}

	gui.setFieldValue('pyth-pair', strategy.pythFeedId);
	gui.setFieldValue('baseline-multiplier', strategy.baselineMultiplier);
	gui.setFieldValue('oracle-price-timeout', strategy.oraclePriceTimeout);

	const rainlangResult = await gui.getComposedRainlang();
	if (rainlangResult.error) throw new Error(rainlangResult.error.readableMsg);

	const argsResult = await gui.getDeploymentTransactionArgs(ownerAddress);
	if (argsResult.error) throw new Error(argsResult.error.readableMsg);

	return {
		side,
		composedRainlang: rainlangResult.value,
		args: argsResult.value
	};
}

/**
 * Build both buy and sell deployments in parallel.
 */
export async function buildBothOrderDeployments(
	strategy: StrategyConfig,
	ownerAddress: string
): Promise<{ buy: DeploymentResult; sell: DeploymentResult }> {
	const [buy, sell] = await Promise.all([
		buildOrderDeployment(strategy, 'buy', ownerAddress),
		buildOrderDeployment(strategy, 'sell', ownerAddress)
	]);
	return { buy, sell };
}
