import type { ReactNode } from "react";
import { AlertTriangle, Info, OctagonAlert } from "lucide-react";

type Tone = "info" | "warn" | "danger";

const TONES: Record<Tone, { box: string; icon: ReactNode }> = {
  info: {
    box: "border-line bg-sunken text-ink",
    icon: <Info className="h-4 w-4 text-accent-ink" />,
  },
  warn: {
    box: "border-warn/30 bg-warn-soft text-ink",
    icon: <AlertTriangle className="h-4 w-4 text-warn" />,
  },
  danger: {
    box: "border-danger/30 bg-danger-soft text-ink",
    icon: <OctagonAlert className="h-4 w-4 text-danger" />,
  },
};

interface NoticeProps {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export default function Notice({
  tone = "info",
  title,
  children,
  actions,
  className = "",
}: NoticeProps) {
  const { box, icon } = TONES[tone];
  return (
    <div
      role={tone === "info" ? "status" : "alert"}
      className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${box} ${className}`}
    >
      <span className="mt-0.5 shrink-0" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-ink-muted">{children}</div>}
        {actions && <div className="flex flex-wrap gap-2 pt-2">{actions}</div>}
      </div>
    </div>
  );
}
