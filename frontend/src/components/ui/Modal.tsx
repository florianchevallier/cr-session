import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible dialog: labelled, traps Tab inside, restores focus to the
 * element that opened it. Escape handling stays with the caller.
 */
export default function Modal({
  title,
  icon,
  onClose,
  closeDisabled = false,
  children,
  footer,
}: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      panel.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }

    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", trap);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", trap);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-ink/40 animate-fade-in"
        onClick={closeDisabled ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-xl rounded-t-2xl border border-line bg-surface p-5 shadow-raised animate-scale-in sm:rounded-2xl sm:p-6"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            {icon && <span className="text-accent-ink">{icon}</span>}
            <h2 id={titleId} className="section-title">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            className="icon-btn -mr-2 -mt-1"
            aria-label="Fermer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
        {footer && (
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
