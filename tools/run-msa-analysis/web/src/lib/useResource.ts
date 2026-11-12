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
  const generation=useRef(0);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(async () => {
    const current=++generation.current;
    setLoading(true);
    try {
      const value = await loader.current();
      if (!mounted.current || current!==generation.current) return;
      setData(value);
      setError(null);
    } catch (e) {
      if (!mounted.current || current!==generation.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (mounted.current && current===generation.current) setLoading(false);
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
