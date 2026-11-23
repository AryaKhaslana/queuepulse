import type { ThroughputPoint } from "@/lib/types";

interface ThroughputChartProps {
  points: ThroughputPoint[];
}

/**
 * Single-purpose SVG throughput chart: completed bars in primary chart hue (--chart-1)
 * and failed/DLQ bars in semantic negative (--negative). Zero chart library bloat.
 */
export function ThroughputChart({ points }: ThroughputChartProps) {
  const maxVal = Math.max(
    4,
    ...points.map((p) => p.completed + p.failed)
  );
  const totalCompleted = points.reduce((acc, p) => acc + p.completed, 0);
  const totalFailed = points.reduce((acc, p) => acc + p.failed, 0);

  const width = 620;
  const height = 168;
  const padLeft = 28;
  const padRight = 10;
  const padTop = 12;
  const padBottom = 26;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;
  const step = points.length > 0 ? chartW / points.length : chartW;
  const barW = Math.max(10, Math.min(26, step * 0.56));

  const yTicks = [0, Math.ceil(maxVal / 2), maxVal];

  return (
    <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div>
          <h2 className="text-[14px] font-semibold text-[var(--text)]">
            Throughput (last 12 minutes)
          </h2>
          <p className="text-[12px] text-[var(--muted)]">
            Completed vs dead-lettered jobs per minute
          </p>
        </div>

        <div className="flex items-center gap-4 text-[12px] tabular-nums">
          <span className="inline-flex items-center gap-1.5 text-[var(--muted)]">
            <span
              className="h-2 w-2 rounded-[2px] bg-[var(--chart-1)]"
              aria-hidden="true"
            />
            Completed <strong className="font-mono font-medium text-[var(--text)]">{totalCompleted}</strong>
          </span>
          <span className="inline-flex items-center gap-1.5 text-[var(--muted)]">
            <span
              className="h-2 w-2 rounded-[2px] bg-[var(--negative)]"
              aria-hidden="true"
            />
            Dead-letter <strong className="font-mono font-medium text-[var(--text)]">{totalFailed}</strong>
          </span>
        </div>
      </div>

      <div className="w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-[168px] w-full"
          role="img"
          aria-label={`Throughput chart showing ${totalCompleted} completed and ${totalFailed} dead-lettered jobs over the last 12 minutes`}
        >
          {/* Horizontal gridlines */}
          {yTicks.map((tick) => {
            const y = padTop + chartH - (tick / maxVal) * chartH;
            return (
              <g key={tick}>
                <line
                  x1={padLeft}
                  x2={width - padRight}
                  y1={y}
                  y2={y}
                  stroke="var(--rule)"
                  strokeWidth="1"
                />
                <text
                  x={padLeft - 6}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-[var(--muted)] font-mono text-[10px]"
                >
                  {tick}
                </text>
              </g>
            );
          })}

          {/* Bars */}
          {points.map((pt, idx) => {
            const cx = padLeft + idx * step + step / 2;
            const x = cx - barW / 2;
            const compH = (pt.completed / maxVal) * chartH;
            const failH = (pt.failed / maxVal) * chartH;
            const compY = padTop + chartH - compH;
            const failY = compY - failH;
            const showLabel = idx % 2 === 0 || idx === points.length - 1;

            return (
              <g key={pt.bucketTs}>
                {pt.completed > 0 && (
                  <rect
                    x={x}
                    y={compY}
                    width={barW}
                    height={Math.max(2, compH)}
                    rx={pt.failed > 0 ? 0 : 2}
                    fill="var(--chart-1)"
                  >
                    <title>{`${pt.label}: ${pt.completed} completed, ${pt.failed} dead-letter`}</title>
                  </rect>
                )}
                {pt.failed > 0 && (
                  <rect
                    x={x}
                    y={failY}
                    width={barW}
                    height={Math.max(2, failH)}
                    rx={2}
                    fill="var(--negative)"
                  >
                    <title>{`${pt.label}: ${pt.failed} dead-letter`}</title>
                  </rect>
                )}
                {pt.completed === 0 && pt.failed === 0 && (
                  <line
                    x1={x}
                    x2={x + barW}
                    y1={padTop + chartH}
                    y2={padTop + chartH}
                    stroke="var(--border)"
                    strokeWidth="2"
                  />
                )}
                {showLabel && (
                  <text
                    x={cx}
                    y={height - 6}
                    textAnchor="middle"
                    className="fill-[var(--muted)] font-mono text-[10px]"
                  >
                    {pt.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
