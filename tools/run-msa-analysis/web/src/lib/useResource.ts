import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fetch state with the four cases the platform asks every data view to cover
 * (ui/README.md §6): loading, error, empty, with data. `data` keeps its last
 * value during a refresh, so a periodic reload doesn't flash the screen back to
 * "Cargando" every few seconds.
 */
export function useResource<T>(load: () => Promise<T>, deps: unknown[] = [], refreshMs?: number) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const value = await loader.current();
      setData(value);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    if (!refreshMs) return undefined;
    const id = setInterval(() => void reload(), refreshMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload };
}
