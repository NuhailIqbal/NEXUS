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

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) setItems(JSON.parse(raw) as T[]);
    } catch {
      // ignore corrupt values
    }
  }, [key]);

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

  const add = useCallback(
    (item: T) => persist([item, ...items]),
    [items, persist],
  );

  const remove = useCallback(
    (id: T["id"]) => persist(items.filter((x) => x.id !== id)),
    [items, persist],
  );

  const update = useCallback(
    (id: T["id"], patch: Partial<T>) =>
      persist(items.map((x) => (x.id === id ? { ...x, ...patch } : x))),
    [items, persist],
  );

  const clear = useCallback(() => persist([]), [persist]);

  return { items, add, remove, update, clear };
}

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
