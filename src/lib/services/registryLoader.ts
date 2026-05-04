/**
 * Loads and parses a Rain strategy registry manifest from GitHub raw content.
 *
 * Registry file format:
 *   line 1 (non-empty): settings.yaml URL
 *   line 2+:            <strategyType> <dotrainUrl>
 */

export interface RegistrySource {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

export interface RegistryEntry {
  strategyType: string;
  url: string;
}

export interface LoadedRegistry {
  source: RegistrySource;
  settingsUrl: string;
  entries: RegistryEntry[];
}

/** Build the GitHub raw content URL for a registry source. */
export function resolveRegistryUrl(source: RegistrySource): string {
  const { owner, repo, ref, path } = source;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
}

/** Parse registry manifest text into a LoadedRegistry. Pure — no I/O. */
export function parseRegistryText(
  source: RegistrySource,
  text: string,
): LoadedRegistry {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) throw new Error("Registry file is empty");

  const settingsUrl = lines[0];
  if (!settingsUrl.startsWith("http")) {
    throw new Error(`First line must be a settings URL, got: ${settingsUrl}`);
  }

  const entries: RegistryEntry[] = [];
  for (const line of lines.slice(1)) {
    const [strategyType, url] = line.split(/\s+/);
    if (!strategyType || !url?.startsWith("http")) continue;
    entries.push({ strategyType, url });
  }

  return { source, settingsUrl, entries };
}

/** Fetch and parse the registry manifest from the given source. */
export async function loadRegistryFromSource(
  source: RegistrySource,
): Promise<LoadedRegistry> {
  const url = resolveRegistryUrl(source);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `HTTP ${resp.status}: failed to fetch registry from ${url}`,
    );
  }
  const text = await resp.text();
  return parseRegistryText(source, text);
}
