/**
 * Creates a RaindexClient from the rain.strategies registry settings,
 * stripping local-db-sync config so no DB callback is required.
 */
import { RaindexClient } from "@rainlanguage/orderbook";
import { REGISTRY_COMMIT } from "$lib/config/strategies";

const REGISTRY_URL = `https://raw.githubusercontent.com/ST0x-Technology/st0x-oracle-server/${REGISTRY_COMMIT}/strategy/registry`;
const REGISTRY_FALLBACK_URL =
  "https://raw.githubusercontent.com/ST0x-Technology/st0x-oracle-server/main/strategy/registry";

let _client: RaindexClient | null = null;

/**
 * Remove local-db-sync / local-db-remotes / local-db-remote fields from
 * a settings YAML string so the client can be created without a DB callback.
 */
function stripLocalDb(yaml: string): string {
  // Remove indented `local-db-remote:` lines inside raindexes entries
  yaml = yaml.replace(/^[ \t]+local-db-remote:[ \t]*\S*[ \t]*\n?/gm, "");
  // Remove top-level `local-db-remotes:` block (and all its indented children)
  yaml = yaml.replace(/^local-db-remotes:(?:\n(?:[ \t]+[^\n]*))*\n?/gm, "");
  // Remove top-level `local-db-sync:` block (and all its indented children)
  yaml = yaml.replace(/^local-db-sync:(?:\n(?:[ \t]+[^\n]*))*\n?/gm, "");
  return yaml;
}

/** Returns a singleton RaindexClient, initialised on first call. */
export async function getOrderbookClient(): Promise<RaindexClient> {
  if (_client) return _client;

  // 1. Fetch the registry manifest to get the settings.yaml URL
  let registryResp = await fetch(REGISTRY_URL);
  if (!registryResp.ok) {
    registryResp = await fetch(REGISTRY_FALLBACK_URL);
  }
  if (!registryResp.ok) {
    throw new Error(`Failed to fetch registry: HTTP ${registryResp.status}`);
  }
  const registryText = await registryResp.text();
  // First non-empty line of the registry file is the settings URL
  const settingsUrl = registryText.trim().split("\n")[0].trim();
  if (!settingsUrl || !settingsUrl.startsWith("http")) {
    throw new Error(`Invalid settings URL in registry: ${settingsUrl}`);
  }

  // 2. Fetch and clean the settings YAML
  const settingsResp = await fetch(settingsUrl);
  if (!settingsResp.ok) {
    throw new Error(`Failed to fetch settings: ${settingsResp.statusText}`);
  }
  const settingsYaml = stripLocalDb(await settingsResp.text());

  // 3. Create the client — no DB callbacks needed after stripping local-db config
  const result = await RaindexClient.new([settingsYaml]);
  if (result.error) {
    throw new Error(result.error.readableMsg);
  }

  _client = result.value;
  return _client;
}
