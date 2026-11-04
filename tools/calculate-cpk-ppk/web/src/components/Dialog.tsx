import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * Modal for the one thing in this tool that deserves a speed bump: confirming a
 * change to what counts as acceptable. Escape and the backdrop close it unless
 * `busy` — a half-sent change must not be dismissable.
 */
export function Dialog({
  title,
  subtitle,
  onClose,
  busy = false,
  children,
  footer,
  returnFocusTo,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
  footer: ReactNode;
  returnFocusTo?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const modal = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const previous = (returnFocusTo ? document.querySelector<HTMLElement>(returnFocusTo) : null) ?? document.activeElement as HTMLElement | null;
    modal.current?.showModal();
    panel.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {

      document.body.style.overflow = overflow;
      modal.current?.close();
      previous?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <dialog ref={modal} aria-labelledby={`${id}-title`} aria-describedby={subtitle ? `${id}-description` : undefined} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 text-text z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        className="my-auto w-full max-w-2xl rounded-md border border-border bg-surface outline-none"
      >
        <header className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-title`} className="text-sm font-medium text-text">{title}</h2>
            {subtitle && <p id={`${id}-description`} className="mt-0.5 text-2xs text-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Cerrar"
            className="rounded border border-transparent p-1 text-faint hover:text-text disabled:opacity-40"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-4">{children}</div>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface2/40 px-4 py-3">{footer}</footer>
      </div>
    </dialog>
  );
}
