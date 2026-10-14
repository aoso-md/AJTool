/**
 * "¿Está recibiendo eventos de verdad?" — the screen that ends diagnosing by
 * screenshots. Everything here comes from GET /api/status; nothing is assumed.
 */
import type { ReactNode } from 'react';
import { PageHeader } from '../components/PageHeader';
import { ErrorState, Loading, Metric, Mono, Panel, StatusChip, formatRelative, formatTime, type Tone } from '../components/primitives';
import { useResource } from '../lib/useResource';
import { api } from '../lib/api';
import { actorLabel } from '../components/StudyMeta';

const POLLER: Record<string, { label: string; tone: Tone }> = {
  idle: { label: 'recibiendo', tone: 'ok' },
  polling: { label: 'consultando', tone: 'info' },
  backoff: { label: 'reintentando', tone: 'warn' },
  error: { label: 'error de configuración', tone: 'danger' },
  disabled: { label: 'desactivado', tone: 'neutral' },
  stopped: { label: 'detenido', tone: 'neutral' },
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[11rem_1fr] gap-3 border-b border-border/60 px-4 py-2 text-2xs last:border-0">
      <dt className="text-faint">{label}</dt>
      <dd className="min-w-0 break-words text-text">{children}</dd>
    </div>
  );
}

export function IntegrationPage({ extra }: { extra?: ReactNode }) {
  const { data: s, error, loading } = useResource(api.status, [], 10_000);

  if (loading && !s) return <Loading label="Leyendo el estado del servicio" />;
  if (error && !s) return <ErrorState title="No se pudo leer el estado del servicio" detail={error.message} />;
  if (!s) return null;

  const poller = POLLER[s.poller.state] ?? { label: s.poller.state, tone: 'neutral' as Tone };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="operación"
        title="Integración con la plataforma"
        description="Cómo está configurada esta instancia y si de verdad está recibiendo eventos del core."
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Recepción" value={poller.label} tone={poller.tone === 'ok' ? 'ok' : poller.tone === 'danger' ? 'danger' : poller.tone === 'warn' ? 'warn' : 'default'} hint={s.poller.lastSuccessAt ? `última consulta ${formatRelative(s.poller.lastSuccessAt)}` : 'sin consultas exitosas'} />
        <Metric label="Eventos procesados" value={s.poller.processedTotal} hint="desde el último arranque" />
        <Metric label="Publicación" value={s.publish.mode === 'live' ? 'activa' : 'sombra'} tone={s.publish.mode === 'live' ? 'ok' : 'warn'} hint={s.publish.mode === 'live' ? 'los resultados se envían al core' : 'calcula y guarda, no envía'} />
        <Metric label="Persistencia" value={s.persistence.tier === 'memory' ? 'memoria' : 'postgres'} tone={s.persistence.durable ? 'ok' : 'warn'} hint={s.persistence.durable ? 'sobrevive reinicios' : 'se pierde al reiniciar'} />
      </div>

      {s.poller.lastError && (
        <ErrorState title={`Último error al consultar el core (${s.poller.lastError.kind})`} detail={`${formatTime(s.poller.lastError.at)} — ${s.poller.lastError.message}`} />
      )}
      {!s.poller.enabled && s.poller.reason && (
        <ErrorState title="Esta instancia no está recibiendo eventos de la plataforma" detail={s.poller.reason} />
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <Panel title="Suscripción" subtitle="GET /api/v1/events/subscriptions/:toolId">
          <dl>
            <Row label="Estado"><StatusChip status={poller.label} tone={poller.tone} /></Row>
            <Row label="Core"><Mono>{s.core.configured ? s.core.baseUrl : 'no configurado'}</Mono></Row>
            <Row label="Consume"><Mono>{s.tool.consumes.join(', ')}</Mono></Row>
            <Row label="Publica"><Mono>{s.tool.produces.join(', ')}</Mono></Row>
            <Row label="Cursor (since_seq)"><Mono>{s.poller.cursor ?? '—'}</Mono></Row>
            <Row label="Arranque en frío">
              <Mono>{s.poller.coldStart ? `seq ${s.poller.coldStart.seq} · ${formatTime(s.poller.coldStart.at)}` : 'no ocurrió en este arranque'}</Mono>
            </Row>
            <Row label="Última consulta"><Mono>{formatTime(s.poller.lastPollAt)}</Mono></Row>
            <Row label="Siguiente consulta"><Mono>{formatTime(s.poller.nextPollAt)}</Mono></Row>
            <Row label="Intervalo"><Mono>{Math.round(s.poller.intervalMs / 1000)} s</Mono></Row>
          </dl>
        </Panel>

        <Panel title="Instancia" subtitle="Lo que imprime el banner de arranque">
          <dl>
            <Row label="Tool"><Mono>{s.tool.id} v{s.tool.version}</Mono></Row>
            <Row label="Cláusula"><Mono>ISO 9001:2015 · {s.tool.clause}</Mono></Row>
            <Row label="Identidad"><Mono>{s.auth === 'sso' ? 'SSO (OIDC)' : 'abierta — sin SSO'}</Mono></Row>
            <Row label="Sesión actual"><Mono>{actorLabel(s.caller)}</Mono></Row>
            <Row label="Persistencia">{s.persistence.detail}</Row>
          </dl>
        </Panel>
      </div>

      {extra}
    </div>
  );
}
