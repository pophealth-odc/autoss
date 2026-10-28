import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { AppProvider } from '../state/app-context';
import { ConnectionManager } from '../state/connection';

function renderSettings() {
  return render(
    <MemoryRouter>
      <AppProvider manager={new ConnectionManager()}>
        <SettingsPage />
      </AppProvider>
    </MemoryRouter>,
  );
}

function markPageAsServedWithItsService(): void {
  const meta = document.createElement('meta');
  meta.name = 'ssg-service';
  meta.content = 'same-origin';
  document.head.appendChild(meta);
}

afterEach(() => {
  document.head.querySelectorAll('meta[name="ssg-service"]').forEach((node) => node.remove());
});

describe('privacy statement', () => {
  it('keeps the usual wording when the service runs on the person\'s own computer', () => {
    renderSettings();
    expect(screen.getByText(/stored only in folders on this computer/)).toBeInTheDocument();
    expect(screen.queryByTestId('privacy-hosted')).not.toBeInTheDocument();
  });

  it('says plainly that the data is on a remote machine when the page is served together with its service', () => {
    markPageAsServedWithItsService();
    renderSettings();
    const list = screen.getByTestId('privacy-hosted');
    expect(list).toHaveTextContent(/remote machine \(a GitHub Codespace\), not on this computer/);
    expect(list).toHaveTextContent(/deleted with it/);
    expect(list).toHaveTextContent(/do not share the link/);
    // The promises that would be false there must be gone.
    expect(screen.queryByText(/stored only in folders on this computer/)).not.toBeInTheDocument();
    expect(screen.queryByText(/talk directly on your computer/)).not.toBeInTheDocument();
  });
});
