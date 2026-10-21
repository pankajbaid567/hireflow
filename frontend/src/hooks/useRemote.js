import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../api/client';

export function useRemote(loader, dependencies = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    let active = true;
    setData(null); setLoading(true); setError('');
    Promise.resolve().then(loader).then(result => { if (active) setData(result); })
      .catch(error => { if (active) setError(errorMessage(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [...dependencies, revision]);
  return { data, setData, loading, error, reload };
}
