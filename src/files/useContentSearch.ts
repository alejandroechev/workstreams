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
  /** Seed the query on first mount (e.g. restored from persisted view-state). */
  initialQuery?: string;
  /** Match case-sensitively (default false). */
  caseSensitive?: boolean;
  /** Treat the query as a regular expression (default false = literal). */
  regex?: boolean;
}

export interface UseContentSearchResult {
  query: string;
  setQuery: (q: string) => void;
  results: FileSearchMatch[];
  loading: boolean;
  /** True when the backend returned the full `limit` (results were capped). */
  truncated: boolean;
  /** Set when the search failed (e.g. an invalid regex), else null. */
  error: string | null;
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
  const caseSensitive = options?.caseSensitive ?? false;
  const regex = options?.regex ?? false;

  const [query, setQuery] = useState(options?.initialQuery ?? "");
  const [results, setResults] = useState<FileSearchMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();

    if (trimmed.length < minLength) {
      setResults([]);
      setTruncated(false);
      setLoading(false);
      setError(null);
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
      setError(null);
      try {
        const found = await backend.searchInFiles(currentDir, trimmed, limit, { caseSensitive, regex });
        if (cancelled) return;
        setResults(found);
        setTruncated(found.length >= limit);
      } catch (e) {
        if (!cancelled) {
          setResults([]);
          setTruncated(false);
          setError(e instanceof Error ? e.message : String(e));
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
  }, [query, currentDir, backend, debounceMs, minLength, limit, caseSensitive, regex]);

  const setQueryStable = useCallback((q: string) => setQuery(q), []);

  return { query, setQuery: setQueryStable, results, loading, truncated, error };
}
