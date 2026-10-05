import { useEffect } from 'react';
import { Ruler } from 'lucide-react';
import { AppShell, Tab } from './components/AppShell';
import { EmptyState } from './components/primitives';
import { IntegrationPage } from './pages/IntegrationPage';
import { StudiesPage } from './pages/StudiesPage';
import { CapturePage } from './pages/CapturePage';
import { StudyPage } from './pages/StudyPage';
import { linkProps, match, usePath } from './lib/router';
import { setAuthMode } from './lib/api';

// Same name the dashboard sidebar shows (core tools.json, `nameEs`), and the
// clause declared in the core's deployments.json.
export const TOOL_NAME = 'Ejecutar Análisis de Sistema de Medición (MSA)';
export const CLAUSE = '7.1.5.2 — trazabilidad de las mediciones';

export function App() {
  const path = usePath();

  useEffect(() => {
    fetch('/auth/me', { credentials: 'same-origin' })
      .then((r) => (r.ok || r.status === 401 ? r.json() : null))
      .then((me: { mode?: 'sso' | 'open' } | null) => setAuthMode(me?.mode ?? null))
      .catch(() => setAuthMode(null));
  }, []);

  const study = match('/estudios/:id', path);
  const capture = match('/capturar/:id', path);
  let page;
  if (path === '/') page = <StudiesPage />;
  else if (path === '/capturar') page = <CapturePage />;
  else if (capture) page = <CapturePage pendingId={capture.id!} />;
  else if (study) page = <StudyPage id={study.id!} />;
  else if (path === '/integracion') page = <IntegrationPage />;
  else page = <EmptyState title="Esta pantalla no existe" detail={path} />;

  const tabs = (
    <nav className="-mb-px flex gap-1" aria-label="Secciones">
      <Tab active={path === '/' || Boolean(study)} {...linkProps('/')}>Estudios</Tab>
      <Tab active={path === '/capturar' || Boolean(capture)} {...linkProps('/capturar')}>Capturar estudio</Tab>
      <Tab active={path === '/integracion'} {...linkProps('/integracion')}>Integración</Tab>
    </nav>
  );

  return (
    <AppShell tool={TOOL_NAME} clause={CLAUSE} icon={<Ruler className="h-4 w-4" aria-hidden="true" />} tabs={tabs}>
      {page}
    </AppShell>
  );
}
