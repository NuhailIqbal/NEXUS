/**
 * Browser-only (localStorage) helpers for demo-style data that never touches the backend API.
 * Exports `useLocalCollection` (a persisted list of `{ id }` items) and `newId` (id generator).
 * Currently only `newId` is imported elsewhere (the automation FlowEditor, for node ids);
 * nothing calls `useLocalCollection` itself.
 */
import { useCallback, useEffect, useState } from "react";

/**
 * Tiny localStorage-backed collection.
 * Used to persist items the user "creates" in demo flows so they
 * survive a refresh, without requiring auth or a backend round-trip.
 */
export function useLocalCollection<T extends { id: string | number }>(
  key: string,
): {
  items: T[];
  add: (item: T) => void;
  remove: (id: T["id"]) => void;
  update: (id: T["id"], patch: Partial<T>) => void;
  clear: () => void;
} {
  const [items, setItems] = useState<T[]>([]);

  // Hydrates `items` from localStorage after mount and again if `key` changes, so the
  // first render always sees an empty list.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) setItems(JSON.parse(raw) as T[]);
    } catch {
      // ignore corrupt values
    }
  }, [key]);

  /**
   * Single write path: replaces the in-memory list and mirrors it to localStorage.
   * Storage failures are swallowed so the in-memory state still updates.
   */
  const persist = useCallback(
    (next: T[]) => {
      setItems(next);
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // quota / private mode: ignore
        }
      }
    },
    [key],
  );

  // add/remove/update compute the next list from the `items` captured at render time, so
  // two calls in the same tick (before a re-render) overwrite each other instead of stacking.

  /** Prepends `item`, so the newest entry is first. */
  const add = useCallback(
    (item: T) => persist([item, ...items]),
    [items, persist],
  );

  /** Removes the item with the given id (no-op if absent). */
  const remove = useCallback(
    (id: T["id"]) => persist(items.filter((x) => x.id !== id)),
    [items, persist],
  );

  /** Shallow-merges `patch` into the item with the given id (no-op if absent). */
  const update = useCallback(
    (id: T["id"], patch: Partial<T>) =>
      persist(items.map((x) => (x.id === id ? { ...x, ...patch } : x))),
    [items, persist],
  );

  /** Empties the collection and overwrites the stored value with an empty list. */
  const clear = useCallback(() => persist([]), [persist]);

  return { items, add, remove, update, clear };
}

/**
 * Returns a unique string id. Uses `crypto.randomUUID` when present; it is missing in
 * insecure (non-HTTPS) contexts and older browsers, where a timestamp + random suffix
 * is used instead.
 */
export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
