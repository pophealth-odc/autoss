import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { useTheme } from './lib/theme';
import { ConnectRoute } from './pages/ConnectRoute';
import { DashboardPage } from './pages/DashboardPage';
import { GalleryPage } from './pages/GalleryPage';
import { SettingsPage } from './pages/SettingsPage';
import { AppProvider } from './state/app-context';
import type { ConnectionManager } from './state/connection';

/**
 * Hash routing keeps every deep link working on GitHub Pages, which cannot rewrite unknown paths to index.html.
 * The saved theme is applied before first paint by the inline script in index.html and kept in step by useTheme().
 */
export function App({ manager }: { manager?: ConnectionManager }) {
  useTheme();
  return (
    <HashRouter>
      <AppProvider {...(manager ? { manager } : {})}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="gallery" element={<GalleryPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="connect" element={<ConnectRoute />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AppProvider>
    </HashRouter>
  );
}
