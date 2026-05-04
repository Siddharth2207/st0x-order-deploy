/**
 * Shared Svelte store for the active registry source and loaded registry manifest.
 * Both the deploy page and the dashboard consume this store.
 *
 * Design:
 * - registrySourceInput: the four editable input fields, persisted to localStorage
 * - loadedRegistry: the parsed registry manifest (null = not yet loaded; static config is the fallback)
 * - hydrateFromStorage(): restore registrySourceInput from localStorage; call in onMount
 * - persistSource(): save to localStorage after a successful load
 */
import { writable } from "svelte/store";
import { REGISTRY_COMMIT } from "$lib/config/strategies";
import type {
  RegistrySource,
  LoadedRegistry,
} from "$lib/services/registryLoader";

export type { RegistrySource, LoadedRegistry };

const STORAGE_KEY = "st0x_registrySource";

export const DEFAULT_SOURCE: RegistrySource = {
  owner: "ST0x-Technology",
  repo: "st0x-oracle-server",
  ref: REGISTRY_COMMIT,
  path: "strategy/registry",
};

/** Currently selected registry source (what the user has in the input fields). */
export const registrySourceInput = writable<RegistrySource>({
  ...DEFAULT_SOURCE,
});

/**
 * The loaded registry manifest.
 * null  = not yet loaded; deploy uses static config as fallback.
 * value = parse result from the last successful "Load Registry" action.
 */
export const loadedRegistry = writable<LoadedRegistry | null>(null);

/**
 * Restore the registry source input from localStorage.
 * Call in onMount on any page that displays the registry source fields.
 * Returns the hydrated source so the caller can sync local vars immediately.
 */
export function hydrateFromStorage(): RegistrySource {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RegistrySource>;
      if (parsed.owner && parsed.repo && parsed.ref && parsed.path) {
        const src = parsed as RegistrySource;
        registrySourceInput.set(src);
        return src;
      }
    }
  } catch {
    // ignore storage errors
  }
  return { ...DEFAULT_SOURCE };
}

/** Persist the registry source to localStorage after a successful load. */
export function persistSource(source: RegistrySource): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(source));
  } catch {
    // ignore storage errors
  }
}
