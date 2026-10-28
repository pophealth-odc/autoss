import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { captureInitialPairing } from './state/app-context';

// A pairing link (#/connect?...) must be read before the router starts: the router would otherwise treat "/connect" as an
// unknown page and redirect away, and the link would be lost. Reading it also removes the token from the address bar.
captureInitialPairing();

const container = document.getElementById('root');
if (!container) throw new Error('The page is missing its #root element.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
