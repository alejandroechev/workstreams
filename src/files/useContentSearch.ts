import { useCallback, useEffect, useState } from "react";
import { useBackend } from "../backend/context";
import type { FileSearchMatch } from "../backend/types";

export interface UseContentSearchOptions {
  /** Debounce window in ms before a query is searched. Default 200. */
  debounceMs?: number;
  /** Minimum trimmed query length before searching. Default 2. */
  minLength?: number;
  /** Max total results requested from the backend (truncation cap). Default 1000. */
  limit?: number;
}

export interface UseContentSearchResult {
  query: string;
  setQuery: (q: string) => void;
  results: FileSearchMatch[];
  loading: boolean;
  /** True when the backend returned the full `limit` (results were capped). */
  truncated: boolean;
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_MIN_LENGTH = 2;
const DEFAULT_LIMIT = 1000;

/**
 * Owns content-search ("search all files") state for a directory: the query,
 * debounced results, loading, and a truncated flag. Mirrors the Ctrl+P
 * filename-search effect but for file *contents* via `backend.searchInFiles`.
 *
 * No-hang guarantee (UI side): the backend command runs the walk off the main
 * thread; here we additionally (a) skip searching for queries below `minLength`,
 * (b) debounce rapid typing, and (c) call `backend.cancelSearches()` before each
 * new search and on unmount so a superseded walk bails promptly.
 */
export function useContentSearch(
  currentDir: string,
  options?: UseContentSearchOptions,
): UseContentSearchResult {
  const backend = useBackend();
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const minLength = options?.minLength ?? DEFAULT_MIN_LENGTH;
  const limit = options?.limit ?? DEFAULT_LIMIT;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileSearchMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();

    if (trimmed.length < minLength) {
      setResults([]);
      setTruncated(false);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      // Cancel any previous in-flight search before starting a new one so a
      // superseded backend walk bails on its next iteration.
      try {
        await backend.cancelSearches();
      } catch {
        /* ignore */
      }
      if (cancelled) return;
      setLoading(true);
      try {
        const found = await backend.searchInFiles(currentDir, trimmed, limit);
        if (cancelled) return;
        setResults(found);
        setTruncated(found.length >= limit);
      } catch {
        if (!cancelled) {
          setResults([]);
          setTruncated(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, debounceMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Bump the epoch immediately so any running walk stops promptly.
      void backend.cancelSearches();
    };
  }, [query, currentDir, backend, debounceMs, minLength, limit]);

  const setQueryStable = useCallback((q: string) => setQuery(q), []);

  return { query, setQuery: setQueryStable, results, loading, truncated };
}
