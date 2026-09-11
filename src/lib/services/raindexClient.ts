/**
 * Creates a RaindexClient from the latest rain.strategies settings.yaml,
 * stripping local-db-sync config so no DB callback is required.
 */
import { RaindexClient } from "@rainlanguage/raindex";

/** Latest shared Raindex settings (networks, subgraphs, raindexes). */
export const SETTINGS_URL =
  "https://raw.githubusercontent.com/rainlanguage/rain.strategies/main/settings.yaml";

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

  const settingsResp = await fetch(SETTINGS_URL);
  if (!settingsResp.ok) {
    throw new Error(`Failed to fetch settings: ${settingsResp.statusText}`);
  }
  const settingsYaml = stripLocalDb(await settingsResp.text());

  const result = await RaindexClient.new([settingsYaml]);
  if (result.error) {
    throw new Error(result.error.readableMsg);
  }

  _client = result.value;
  return _client;
}
