import { useCallback, useEffect, useState } from 'react';

import type { CatalogSnapshot } from '@/data/catalog-repository';
import { loadCatalog } from '@/data/catalog-repository';

type CatalogState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: CatalogSnapshot }
  | { status: 'error'; message: string };

export function usePodcastCatalog() {
  const [state, setState] = useState<CatalogState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    void loadCatalog(controller.signal)
      .then((snapshot) => setState({ status: 'ready', snapshot }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Murmur could not load this feed.',
        });
      });

    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((current) => current + 1);
  }, []);

  return { ...state, retry };
}
