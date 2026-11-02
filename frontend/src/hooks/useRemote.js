import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api/client';

const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/**
 * Loads remote data. A manual reload (or a poll) keeps the current data on screen and reports `refreshing`;
 * only a change of dependencies (a different resource) clears it. A response that arrives after a newer request
 * started is ignored. (Audit F-023: every poll used to blank the page.)
 */
export function useRemote(loader, dependencies = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const previous = useRef(null);
  const reload = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    let active = true;
    const sameResource = same(previous.current, dependencies);
    previous.current = dependencies;
    if (sameResource) setRefreshing(true); else { setData(null); setLoading(true); }
    setError('');
    Promise.resolve().then(loader).then(result => { if (active) setData(result); })
      .catch(error => { if (active) setError(errorMessage(error)); })
      .finally(() => { if (active) { setLoading(false); setRefreshing(false); } });
    return () => { active = false; };
  }, [...dependencies, revision]);
  return { data, setData, loading, refreshing, error, reload };
}
