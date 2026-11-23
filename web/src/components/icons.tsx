import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/** Custom QueuePulse mark: three synchronized queue lanes with a live pulse tick. */
export function QueuePulseMark({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect
        x="2"
        y="3"
        width="20"
        height="18"
        rx="4"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M6.5 8.5H12.5M6.5 12H10.5L12.5 9.5L14.5 14.5L16 12H17.5M6.5 15.5H11"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconOverview(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}

export function IconQueue(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M2.5 4h11M2.5 8h8M2.5 12h11" strokeLinecap="round" />
    </svg>
  );
}

export function IconDeadLetter(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M8 2.2 14 13H2L8 2.2Z" strokeLinejoin="round" />
      <path d="M8 6.2v3.3M8 11.2v.4" strokeLinecap="round" />
    </svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <circle cx="8" cy="8" r="2.2" />
      <path
        d="M8 1.8v1.5M8 12.7v1.5M1.8 8h1.5M12.7 8h1.5M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.2 3.2" strokeLinecap="round" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" {...props}>
      <path d="M8 3.2v9.6M3.2 8h9.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconRetry(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M13 8a5 5 0 1 1-1.3-3.4" strokeLinecap="round" />
      <path d="M13 2.5v2.8h-2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconPause(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" {...props}>
      <path d="M5.5 3.5v9M10.5 3.5v9" strokeLinecap="round" />
    </svg>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M4.5 3.2 12.5 8l-8 4.8V3.2Z" strokeLinejoin="round" />
    </svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" {...props}>
      <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M2.8 4.5h10.4M6.2 2.5h3.6M4.5 4.5l.6 8.8h5.8l.6-8.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconTheme(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11V2.5Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" {...props}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" strokeLinecap="round" />
    </svg>
  );
}
