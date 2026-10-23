/**
 * Loads ONE report widget from /call-consumption. Every widget on a page uses its own instance, so each has its own
 * loading flag and one slow or failing widget never blanks the page (and the global blocking loader never fires).
 *
 * `applied` is the filter set the user last pressed Search with; the widget refetches whenever it changes, or when
 * `reload()` is called. A response that arrives after a newer request was started is ignored, so quickly changing
 * filters can't leave an old answer on screen. A failure (HTTP error, network error, business error) always clears
 * `loading`, sets `error` and raises a toast: the spinner can never get stuck.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/services/api";
import { filterParams, type CCFilters } from "@/lib/callConsumption";

export type Section<T> = { data: T | null; loading: boolean; error: string | null; reload: () => void };

export function useSection<T>(
  path: string,
  applied: CCFilters,
  opts: { extra?: Record<string, string | undefined>; label?: string; enabled?: boolean } = {},
): Section<T> {
  const { extra, label = "this section", enabled = true } = opts;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  const extraKey = JSON.stringify(extra ?? {});
  const filtersKey = JSON.stringify(filterParams(applied));

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const mine = ++latest.current;
    setLoading(true);
    setError(null);
    api
      .getCallConsumption<T>(path, filterParams(applied, extra))
      .then(({ data: d, error: e }) => {
        if (mine !== latest.current) return;
        if (e || d === null || d === undefined) {
          const message = typeof e === "string" && e ? e : `Failed to load ${label}. Please try again.`;
          setError(message);
          setData(null);
          toast.error(message);
        } else {
          setData(d);
        }
      })
      .catch(() => {
        if (mine !== latest.current) return;
        const message = `Failed to load ${label}. Please try again.`;
        setError(message);
        setData(null);
        toast.error(message);
      })
      .finally(() => {
        if (mine === latest.current) setLoading(false);
      });
    // `applied` and `extra` are tracked through their serialised keys so a new-but-equal object doesn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, filtersKey, extraKey, enabled, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}
