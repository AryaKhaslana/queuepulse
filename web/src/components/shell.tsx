import * as React from "react";
import { cn } from "@/lib/utils";
import type { RuntimeMode } from "@/lib/types";
import {
  IconClose,
  IconDeadLetter,
  IconMenu,
  IconOverview,
  IconQueue,
  IconSearch,
  IconSettings,
  IconTheme,
  QueuePulseMark,
} from "./icons";

export type NavSection = "overview" | "jobs" | "dlq" | "settings";

interface ShellProps {
  activeNav: NavSection;
  onSelectNav: (nav: NavSection) => void;
  deadLetterCount: number;
  activeCount: number;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  runtimeMode: RuntimeMode;
  darkMode: boolean;
  onToggleTheme: () => void;
  children: React.ReactNode;
}

export function Shell({
  activeNav,
  onSelectNav,
  deadLetterCount,
  activeCount,
  searchQuery,
  onSearchChange,
  searchInputRef,
  runtimeMode,
  darkMode,
  onToggleTheme,
  children,
}: ShellProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);

  const navItems: Array<{
    id: NavSection;
    label: string;
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    count?: number;
    danger?: boolean;
  }> = [
    { id: "overview", label: "Overview", icon: IconOverview },
    { id: "jobs", label: "Jobs queue", icon: IconQueue, count: activeCount },
    {
      id: "dlq",
      label: "Dead-letter queue",
      icon: IconDeadLetter,
      count: deadLetterCount,
      danger: deadLetterCount > 0,
    },
    { id: "settings", label: "Pool & runtime", icon: IconSettings },
  ];

  const renderNavList = (onAfterSelect?: () => void) => (
    <nav aria-label="Primary navigation" className="flex flex-col gap-0.5 px-2.5">
      {navItems.map((item) => {
        const Icon = item.icon;
        const active = activeNav === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              onSelectNav(item.id);
              onAfterSelect?.();
            }}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-9 w-full items-center justify-between rounded-[6px] px-2.5 text-[13px] transition-colors cursor-pointer",
              active
                ? "bg-[var(--active)] font-semibold text-[var(--text)]"
                : "text-[var(--muted)] hover:bg-[var(--active)]/60 hover:text-[var(--text)]"
            )}
          >
            <span className="flex items-center gap-2.5">
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{item.label}</span>
            </span>
            {typeof item.count === "number" && item.count > 0 && (
              <span
                className={cn(
                  "font-mono text-[11px] tabular-nums rounded-[4px] px-1.5 py-0.5 leading-none",
                  item.danger
                    ? "bg-[var(--pill-negative-bg)] text-[var(--pill-negative-ink)] font-medium"
                    : "bg-[var(--surface)] text-[var(--muted)] border border-[var(--border)]"
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen w-full flex-col bg-[var(--ground)] text-[var(--text)] md:flex-row">
      {/* Desktop L-frame sidebar (no divider border against topbar per Framed Sheet spec) */}
      <aside className="hidden w-[228px] shrink-0 flex-col justify-between bg-[var(--ground)] py-3 md:flex">
        <div>
          <div className="flex h-9 items-center gap-2.5 px-4 mb-4">
            <span className="text-[var(--accent)] flex items-center">
              <QueuePulseMark className="h-[22px] w-[22px]" />
            </span>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold leading-none tracking-[-0.01em]">
                QueuePulse
              </div>
              <div className="mt-1 text-[11px] text-[var(--muted)] leading-none">
                Local job engine
              </div>
            </div>
          </div>

          {renderNavList()}
        </div>

        <div className="px-4 pt-4">
          <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[12px]">
            <div className="flex items-center gap-1.5 font-medium text-[var(--text)]">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full shrink-0",
                  runtimeMode === "go-api" ? "bg-[var(--positive)]" : "bg-[var(--accent)]"
                )}
                aria-hidden="true"
              />
              <span>{runtimeMode === "go-api" ? "Go SQLite WAL" : "Browser Sandbox"}</span>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-[var(--muted)]">
              {runtimeMode === "go-api"
                ? "Connected to local Go server via SSE."
                : "Running local browser workers with localStorage."}
            </p>
          </div>
        </div>
      </aside>

      {/* Right column: 48px chromeless topbar + white inset content sheet */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 bg-[var(--ground)] px-3 md:px-4">
          {/* Mobile menu button + brand */}
          <div className="flex items-center gap-2 md:hidden">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              className="flex h-9 w-9 items-center justify-center rounded-[6px] text-[var(--text)] hover:bg-[var(--active)] cursor-pointer"
            >
              <IconMenu className="h-4 w-4" />
            </button>
            <span className="text-[var(--accent)]">
              <QueuePulseMark className="h-5 w-5" />
            </span>
            <span className="text-[14px] font-semibold">QueuePulse</span>
          </div>

          {/* Centered search input on desktop */}
          <div className="relative hidden max-w-[460px] flex-1 md:block md:mx-auto">
            <IconSearch
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]"
              aria-hidden="true"
            />
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Filter jobs by name, ID, queue, or error"
              aria-label="Filter jobs"
              className="h-8 w-full rounded-[6px] border border-[var(--border)] bg-[var(--surface)] pl-8 pr-12 text-[13px] text-[var(--text)] placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:outline-none"
            />
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-[var(--border)] bg-[var(--raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
              /
            </kbd>
          </div>

          {/* Right controls */}
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-[5px] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] font-medium text-[var(--muted)] sm:inline-flex">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  runtimeMode === "go-api" ? "bg-[var(--positive)]" : "bg-[var(--accent)]"
                )}
                aria-hidden="true"
              />
              {runtimeMode === "go-api" ? "Live Go API" : "Interactive Sandbox"}
            </span>

            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={darkMode ? "Switch to light theme" : "Switch to dark theme"}
              title={darkMode ? "Switch to light theme" : "Switch to dark theme"}
              className="flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[12px] font-medium text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--raised)] cursor-pointer"
            >
              <IconTheme className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">{darkMode ? "Light" : "Dark"}</span>
            </button>
          </div>
        </header>

        {/* Inset work sheet: 8px inset from right & bottom edges, 16px corners, 1px hairline border */}
        <main className="flex-1 bg-[var(--surface)] border-t border-[var(--border)] md:mr-2 md:mb-2 md:rounded-[16px] md:border md:border-[var(--border)]">
          <div className="mx-auto w-full max-w-[1200px] px-4 py-5 md:px-6 md:py-6">
            {children}
          </div>
        </main>
      </div>

      {/* Mobile navigation drawer */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-50 flex bg-black/45 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setMobileMenuOpen(false);
          }}
        >
          <div className="flex h-full w-[260px] flex-col bg-[var(--ground)] py-4">
            <div className="flex items-center justify-between px-4 mb-4">
              <div className="flex items-center gap-2">
                <span className="text-[var(--accent)]">
                  <QueuePulseMark className="h-5 w-5" />
                </span>
                <span className="text-[14px] font-semibold">QueuePulse</span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close navigation menu"
                className="flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--muted)] hover:bg-[var(--active)] cursor-pointer"
              >
                <IconClose className="h-4 w-4" />
              </button>
            </div>

            <div className="px-3 mb-3">
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Filter jobs..."
                aria-label="Filter jobs"
                className="h-9 w-full rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)]"
              />
            </div>

            {renderNavList(() => setMobileMenuOpen(false))}
          </div>
        </div>
      )}
    </div>
  );
}
