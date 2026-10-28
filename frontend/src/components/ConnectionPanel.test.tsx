import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionPanel } from './ConnectionPanel';
import { AppProvider, type AppContextValue } from '../state/app-context';
import type { ConnectionState } from '../state/connection';
import { ConnectionManager } from '../state/connection';

/** A manager whose state is set by the test and which never touches the network. */
function fakeManager(state: Partial<ConnectionState>): ConnectionManager {
  const manager = new ConnectionManager();
  const full: ConnectionState = {
    phase: 'idle',
    serviceUrl: 'http://127.0.0.1:4577',
    hasToken: false,
    rememberToken: false,
    problem: null,
    message: '',
    advice: '',
    health: null,
    info: null,
    live: false,
    lastConnectedAt: null,
    ...state,
  };
  vi.spyOn(manager, 'getState').mockReturnValue(full);
  manager.getState = () => full;
  vi.spyOn(manager, 'connect').mockResolvedValue();
  vi.spyOn(manager, 'stop').mockImplementation(() => undefined);
  return manager;
}

function renderPanel(state: Partial<ConnectionState>, props: { compact?: boolean } = {}) {
  const manager = fakeManager(state);
  const view = render(
    <MemoryRouter>
      <AppProvider manager={manager}>
        <ConnectionPanel {...props} />
      </AppProvider>
    </MemoryRouter>,
  );
  return { manager, ...view };
}

describe('ConnectionPanel honesty', () => {
  it('shows nothing while connected', () => {
    const { container } = renderPanel({ phase: 'connected' });
    expect(container).toBeEmptyDOMElement();
  });

  it('explains an unreachable service and says capturing is unavailable', () => {
    renderPanel({ phase: 'failed', problem: 'unreachable', message: 'Could not reach the service.', advice: 'Start the service.' });
    expect(screen.getByRole('heading', { name: 'The local service is not reachable' })).toBeInTheDocument();
    // The statement may appear more than once (warning + setup guide); at least one must say capturing is unavailable.
    expect(screen.getAllByText(/Capturing screenshots is unavailable until the service is connected/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/cannot control your browser by itself/).length).toBeGreaterThanOrEqual(1);
  });

  it('shows the setup steps when the service is unreachable', () => {
    renderPanel({ phase: 'failed', problem: 'unreachable', message: 'x' });
    expect(screen.getByText(/1\. Install the local service/)).toBeInTheDocument();
    expect(screen.getByText(/2\. Start it/)).toBeInTheDocument();
    expect(screen.getByText(/3\. Pair this page with it/)).toBeInTheDocument();
    expect(screen.getByLabelText('Command to start the service')).toHaveTextContent('start-service.bat');
  });

  it('tells the person to answer the browser prompt while waiting for permission', () => {
    renderPanel({ phase: 'waiting-for-permission', message: 'waiting' });
    expect(screen.getByRole('heading', { name: /browser may be asking for permission/i })).toBeInTheDocument();
    expect(screen.getByText(/choose/i)).toBeInTheDocument();
  });

  it('asks for a token when the service is reachable but not paired', () => {
    renderPanel({ phase: 'needs-token', problem: 'unauthorized', hasToken: false });
    expect(screen.getByRole('heading', { name: 'Pair this page with the service' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Settings' })).toBeInTheDocument();
  });

  it('distinguishes a rejected token from a missing one', () => {
    renderPanel({ phase: 'needs-token', problem: 'unauthorized', hasToken: true });
    expect(screen.getByRole('heading', { name: 'The pairing token was not accepted' })).toBeInTheDocument();
  });

  it.each([
    ['permission-denied', 'Your browser blocked access to your computer'],
    ['origin-not-allowed', 'The service does not allow this website'],
    ['bad-host', 'The service address is not accepted'],
    ['rate-limited', 'Too many wrong tokens'],
    ['incompatible', 'This is not a compatible service'],
  ] as const)('has a specific headline for %s', (problem, headline) => {
    renderPanel({ phase: 'failed', problem, message: 'm', advice: 'a' });
    expect(screen.getByRole('heading', { name: headline })).toBeInTheDocument();
  });

  it('lets the person retry', async () => {
    const { manager } = renderPanel({ phase: 'failed', problem: 'unreachable', message: 'x' });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(manager.connect).toHaveBeenCalled();
  });

  it('compact mode leaves out the long setup guide', () => {
    renderPanel({ phase: 'failed', problem: 'unreachable', message: 'x' }, { compact: true });
    expect(screen.queryByText(/Install the local service/)).not.toBeInTheDocument();
    expect(screen.getByText(/Capturing screenshots is unavailable/)).toBeInTheDocument();
  });
});

// Keep the context type referenced so a rename in the provider is caught here.
void (null as unknown as AppContextValue);
