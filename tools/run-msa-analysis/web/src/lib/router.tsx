/**
 * Minimal client-side routing. A tool navigates between three or four screens
 * (ui/README.md §5); a router library for that would be the only dependency the
 * platform template doesn't list. Deep links work because the server answers
 * every non-API path with index.html.
 */
import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

const EVENT = 'tool:navigate';

export function navigate(to: string) {
  if (to === window.location.pathname + window.location.search) return;
  window.history.pushState({}, '', to);
  window.dispatchEvent(new Event(EVENT));
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(EVENT, update);
    };
  }, []);
  return path;
}

/** `/estudios/:id` against `/estudios/abc` -> { id: 'abc' }; no match -> null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i += 1) {
    const segment = p[i]!;
    const value = s[i]!;
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(value);
    else if (segment !== value) return null;
  }
  return params;
}

/** Props for an <a> (or the shell's <Tab>) that navigates without reloading. */
export function linkProps(to: string): Pick<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> {
  return {
    href: to,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(to);
    },
  };
}

export function Link({ to, className = '', children }: { to: string; className?: string; children: ReactNode }) {
  return (
    <a {...linkProps(to)} className={`text-info hover:underline ${className}`}>
      {children}
    </a>
  );
}
