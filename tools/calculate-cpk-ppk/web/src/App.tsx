import { useEffect } from 'react';
import { Activity } from 'lucide-react';
import { AppShell, Tab } from './components/AppShell';
import { EmptyState } from './components/primitives';
import { IntegrationPage } from './pages/IntegrationPage';
import { StudiesPage } from './pages/StudiesPage';
import { NewStudyPage } from './pages/NewStudyPage';
import { StudyPage } from './pages/StudyPage';
import { SpecsPanel } from './pages/SpecsPanel';
import { linkProps, match, usePath } from './lib/router';
import { setAuthMode } from './lib/api';

// Same name the dashboard sidebar shows (core tools.json, `nameEs`), and the
// clause declared in the core's deployments.json. The operator arrives here from
// the dashboard by a direct link and must recognise where they are.
export const TOOL_NAME = 'Calcular Cpk y Ppk';
export const CLAUSE = '9.1.3 — análisis y evaluación';

export function App() {
  const path = usePath();

  useEffect(() => {
    fetch('/auth/me', { credentials: 'same-origin' })
      .then((r) => (r.ok || r.status === 401 ? r.json() : null))
      .then((me: { mode?: 'sso' | 'open' } | null) => setAuthMode(me?.mode ?? null))
      .catch(() => setAuthMode(null));
  }, []);

  const study = match('/estudios/:id', path);
  let page;
  if (path === '/') page = <StudiesPage />;
  else if (path === '/nuevo') page = <NewStudyPage />;
  else if (study) page = <StudyPage id={study.id!} />;
  else if (path === '/integracion') page = <IntegrationPage extra={<SpecsPanel />} />;
  else page = <EmptyState title="Esta pantalla no existe" detail={path} />;

  const tabs = (
    <nav className="-mb-px flex gap-1" aria-label="Secciones">
      <Tab active={path === '/' || Boolean(study)} {...linkProps('/')}>Estudios</Tab>
      <Tab active={path === '/nuevo'} {...linkProps('/nuevo')}>Nuevo estudio</Tab>
      <Tab active={path === '/integracion'} {...linkProps('/integracion')}>Integración</Tab>
    </nav>
  );

  return (
    <AppShell tool={TOOL_NAME} clause={CLAUSE} icon={<Activity className="h-4 w-4" aria-hidden="true" />} tabs={tabs}>
      {page}
    </AppShell>
  );
}
