/**
 * Generic order deployment service.
 *
 * Fetches the .rain strategy file and shared settings.yaml from GitHub,
 * then builds a DotrainOrderGui instance for any strategy type and returns
 * DeploymentTransactionArgs ready for an EOA wallet or SAFE.
 *
 * All strategy-specific params (field values, token keys, deposit amounts)
 * come from the OrderConfig — add new strategy types purely in tokens.yaml.
 */

import { DotrainOrderGui } from "@rainlanguage/orderbook";
import type { DeploymentTransactionArgs } from "@rainlanguage/orderbook";
import type { OrderConfig } from "$lib/config/strategies";
import { REGISTRY_COMMIT } from "$lib/config/strategies";

const BASE_URL = `https://raw.githubusercontent.com/rainlanguage/rain.strategies/${REGISTRY_COMMIT}`;

// Cache raw text fetches so each file is only downloaded once per session
const fetchCache = new Map<string, Promise<string>>();

function fetchText(url: string): Promise<string> {
  if (!fetchCache.has(url)) {
    fetchCache.set(
      url,
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.statusText}`);
        return r.text();
      }),
    );
  }
  return fetchCache.get(url)!;
}

/**
 * Fetch the .rain file for a strategy type and the shared settings.yaml,
 * then instantiate a DotrainOrderGui for the given deployment key.
 */
async function buildGui(
  strategyType: string,
  deploymentKey: string,
): Promise<DotrainOrderGui> {
  const [dotrain, settings] = await Promise.all([
    fetchText(`${BASE_URL}/src/${strategyType}.rain`),
    fetchText(`${BASE_URL}/settings.yaml`),
  ]);

  const result = await DotrainOrderGui.newWithDeployment(
    dotrain,
    [settings],
    deploymentKey,
  );
  if (result.error) throw new Error(result.error.readableMsg);
  return result.value;
}

export interface DeploymentResult {
  label: string;
  composedRainlang: string;
  args: DeploymentTransactionArgs;
}

/**
 * Build deployment args for a single order.
 * Fully strategy-agnostic — driven entirely by the OrderConfig.
 */
export async function buildOrderDeployment(
  order: OrderConfig,
  ownerAddress: string,
): Promise<DeploymentResult> {
  const gui = await buildGui(order.strategyType, order.deploymentKey);

  for (const [key, address] of Object.entries(order.selectTokens)) {
    await gui.setSelectToken(key, address);
  }

  for (const [binding, value] of Object.entries(order.fieldValues)) {
    gui.setFieldValue(binding, value);
  }

  for (const [tokenKey, amount] of Object.entries(order.deposits)) {
    if (amount && amount !== "0") {
      gui.setDeposit(tokenKey, amount);
    }
  }

  const rainlangResult = await gui.getComposedRainlang();
  if (rainlangResult.error) throw new Error(rainlangResult.error.readableMsg);

  const argsResult = await gui.getDeploymentTransactionArgs(ownerAddress);
  if (argsResult.error) throw new Error(argsResult.error.readableMsg);

  return {
    label: order.label,
    composedRainlang: rainlangResult.value,
    args: argsResult.value,
  };
}
