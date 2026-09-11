/**
 * Generic order deployment service.
 *
 * Fetches the .rain strategy file and shared settings.yaml from GitHub,
 * then builds a RaindexOrderBuilder instance for any strategy type and returns
 * DeploymentTransactionArgs ready for an EOA wallet or SAFE.
 *
 * All strategy-specific params (field values, token keys, deposit amounts)
 * come from the OrderConfig — add new strategy types purely in tokens.yaml.
 */

import { RaindexOrderBuilder } from "@rainlanguage/raindex";
import type { DeploymentTransactionArgs } from "@rainlanguage/raindex";
import type { OrderConfig } from "$lib/config/strategies";
import { REGISTRY_COMMIT } from "$lib/config/strategies";
import type { LoadedRegistry } from "$lib/services/registryLoader";

const REGISTRY_URL = `https://raw.githubusercontent.com/ST0x-Technology/st0x-oracle-server/${REGISTRY_COMMIT}/strategy/registry`;
const REGISTRY_FALLBACK_URL =
  "https://raw.githubusercontent.com/ST0x-Technology/st0x-oracle-server/main/strategy/registry";

// Cache raw text fetches so each file is only downloaded once per session
const fetchCache = new Map<string, Promise<string>>();
let registryCache: Promise<{
  settingsUrl: string;
  strategyUrls: Map<string, string>;
}> | null = null;

function fetchText(url: string): Promise<string> {
  if (!fetchCache.has(url)) {
    fetchCache.set(
      url,
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch ${url}: HTTP ${r.status}`);
        return r.text();
      }),
    );
  }
  return fetchCache.get(url)!;
}

async function fetchTextWithFallback(
  primaryUrl: string,
  fallbackUrl: string,
): Promise<string> {
  try {
    return await fetchText(primaryUrl);
  } catch (primaryError) {
    try {
      return await fetchText(fallbackUrl);
    } catch {
      throw primaryError;
    }
  }
}

async function getRegistryConfig(): Promise<{
  settingsUrl: string;
  strategyUrls: Map<string, string>;
}> {
  if (!registryCache) {
    registryCache = (async () => {
      const registryText = await fetchTextWithFallback(
        REGISTRY_URL,
        REGISTRY_FALLBACK_URL,
      );
      const lines = registryText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length === 0) throw new Error("Registry file is empty");

      const settingsUrl = lines[0];
      if (!settingsUrl.startsWith("http")) {
        throw new Error(`Invalid settings URL in registry: ${settingsUrl}`);
      }

      const strategyUrls = new Map<string, string>();
      for (const line of lines.slice(1)) {
        const [strategyType, url] = line.split(/\s+/);
        if (!strategyType || !url || !url.startsWith("http")) continue;
        strategyUrls.set(strategyType, url);
      }
      return { settingsUrl, strategyUrls };
    })();
  }
  return registryCache;
}

/**
 * Fetch the .rain file for a strategy type and the shared settings.yaml,
 * then instantiate a RaindexOrderBuilder for the given deployment key.
 *
 * When a dynamic registry is provided it takes precedence over the static
 * GitHub commit URL, allowing runtime strategy source selection.
 */
async function buildGui(
  strategyType: string,
  deploymentKey: string,
  registry?: LoadedRegistry,
): Promise<RaindexOrderBuilder> {
  let strategyUrl: string;
  let settingsUrl: string;

  if (registry) {
    const entry = registry.entries.find((e) => e.strategyType === strategyType);
    if (!entry) {
      const available = registry.entries.map((e) => e.strategyType).join(", ");
      throw new Error(
        `Strategy "${strategyType}" not found in loaded registry. Available: ${available || "(none)"}`,
      );
    }
    strategyUrl = entry.url;
    settingsUrl = registry.settingsUrl;
  } else {
    const staticReg = await getRegistryConfig();
    const url = staticReg.strategyUrls.get(strategyType);
    if (!url) {
      throw new Error(
        `Strategy "${strategyType}" not found in registry ${REGISTRY_URL}`,
      );
    }
    strategyUrl = url;
    settingsUrl = staticReg.settingsUrl;
  }

  const [dotrain, settings] = await Promise.all([
    fetchText(strategyUrl),
    fetchText(settingsUrl),
  ]);

  const result = await RaindexOrderBuilder.newWithDeployment(
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
  /** Vault IDs resolved after deployment (auto-generated or from tokens.yaml). */
  vaultIds: Record<string, Record<string, string>>;
}

/**
 * Build deployment args for a single order.
 * Fully strategy-agnostic — driven entirely by the OrderConfig.
 *
 * Pass a LoadedRegistry to override the static GitHub commit URL with a
 * dynamically selected registry source.
 */
export async function buildOrderDeployment(
  order: OrderConfig,
  ownerAddress: string,
  registry?: LoadedRegistry,
): Promise<DeploymentResult> {
  const gui = await buildGui(order.strategyType, order.deploymentKey, registry);

  for (const [key, address] of Object.entries(order.selectTokens)) {
    const selectResult = await gui.setSelectToken(key, address);
    if (selectResult.error) {
      throw new Error(
        `Failed to set select token ${key}: ${selectResult.error.readableMsg}`,
      );
    }
  }

  for (const [binding, value] of Object.entries(order.fieldValues)) {
    const fieldResult = gui.setFieldValue(binding, value);
    if (fieldResult.error) {
      throw new Error(
        `Failed to set field ${binding}: ${fieldResult.error.readableMsg}`,
      );
    }
  }

  for (const [tokenKey, amount] of Object.entries(order.deposits)) {
    if (amount && amount !== "0") {
      const depositResult = await gui.setDeposit(tokenKey, amount);
      if (depositResult.error) {
        throw new Error(
          `Failed to set deposit ${tokenKey}: ${depositResult.error.readableMsg}`,
        );
      }
    }
  }

  // Set vault IDs (Rain "word IDs") when specified in tokens.yaml.
  // This ensures buy and sell orders within a strategy pair share the same vaults.
  if (order.vaultIds) {
    for (const [ioType, tokenVaults] of Object.entries(order.vaultIds)) {
      for (const [tokenKey, vaultId] of Object.entries(tokenVaults)) {
        const vaultResult = gui.setVaultId(
          ioType as "input" | "output",
          tokenKey,
          vaultId as `0x${string}`,
        );
        if (vaultResult?.error) {
          throw new Error(
            `Failed to set vault ID for ${ioType}.${tokenKey}: ${vaultResult.error.readableMsg}`,
          );
        }
      }
    }
  }

  const rainlangResult = await gui.getComposedRainlang();
  if (rainlangResult.error) throw new Error(rainlangResult.error.readableMsg);

  const argsResult = await gui.getDeploymentTransactionArgs(ownerAddress);
  if (argsResult.error) throw new Error(argsResult.error.readableMsg);

  // Retrieve resolved vault IDs (from tokens.yaml or auto-generated by GUI)
  const vaultIds: Record<string, Record<string, string>> = {};
  const vaultIdsResult = gui.getVaultIds();
  if (!vaultIdsResult?.error && vaultIdsResult?.value) {
    for (const [ioType, tokens] of vaultIdsResult.value) {
      vaultIds[ioType] = {};
      for (const [tokenKey, vaultId] of tokens) {
        if (vaultId !== undefined) vaultIds[ioType][tokenKey] = vaultId;
      }
    }
  }

  return {
    label: order.label,
    composedRainlang: rainlangResult.value,
    args: argsResult.value,
    vaultIds,
  };
}
