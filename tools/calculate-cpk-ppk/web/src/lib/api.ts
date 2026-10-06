/**
 * HTTP client of this tool's UI.
 *
 * Relative URLs on purpose: the SPA and the API are served by the SAME origin
 * (platform rule, docker/README.md §1), so the session cookie travels on its
 * own and there is no API key anywhere in this bundle. The machine credential
 * (`x-api-key`) stays on the server, where it belongs.
 */
import type { ToolStatus } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let authMode: 'sso' | 'open' | null = null;

/** Called once with /auth/me so a 401 knows whether a login exists to go to. */
export function setAuthMode(mode: 'sso' | 'open' | null) {
  authMode = mode;
}

function messageFrom(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as { errors?: unknown; detail?: unknown; error?: unknown };
    if (Array.isArray(b.errors) && b.errors.length) return b.errors.join(' ');
    if (typeof b.detail === 'string') return b.detail;
    if (typeof b.error === 'string') return b.error;
  }
  return `HTTP ${status}`;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    credentials: 'same-origin',
  });

  if (response.status === 401) {
    if (authMode === 'sso') {
      // Session expired with the tab open: back to the IdP, keeping where the
      // user was so they land on the same screen, not on the home page.
      const returnTo = window.location.pathname + window.location.search;
      window.location.assign(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
      throw new ApiError(401, 'Sesión vencida — redirigiendo al inicio de sesión');
    }
    throw new ApiError(
      401,
      'El servicio exige credencial pero el SSO no está configurado. Con TOOL_API_KEY puesta y sin OIDC_ISSUER, solo los servicios pueden entrar.',
    );
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) throw new ApiError(response.status, messageFrom(body, response.status), body);
  return body as T;
}

export const api = {
  request,
  status: () => request<ToolStatus>('/api/status'),
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
};
