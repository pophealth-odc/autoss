import { useEffect } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../state/app-context';

/**
 * Target of pairing links: `#/connect?service=<address>&token=<token>`.
 *
 * It hands the details to the confirmation dialog and immediately replaces the address with `#/settings`, so the token is
 * not left in the address bar or the history. (A link that is opened in a fresh tab is read earlier, in main.tsx, before
 * the router starts; this route covers links opened while the page is already loaded.)
 */
export function ConnectRoute() {
  const [params] = useSearchParams();
  const { offerPairing } = useApp();
  const serviceUrl = params.get('service');
  const token = params.get('token');

  useEffect(() => {
    if (serviceUrl !== null || token !== null) offerPairing({ serviceUrl, token });
  }, [serviceUrl, token, offerPairing]);

  return <Navigate to="/settings" replace />;
}
