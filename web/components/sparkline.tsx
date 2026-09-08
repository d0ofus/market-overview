import { marketSeriesSegments } from "@/lib/market-series";

type Props = {
  values: Array<number | null>;
  dates?: string[];
  width?: number;
  height?: number;
};

export function Sparkline({ values, dates, width = 100, height = 26 }: Props) {
  const segments = marketSeriesSegments(values, width, height);
  if (!segments.length) return <span className="text-xs text-slate-500">N/A</span>;
  const first = segments[0][0];
  const last = segments.at(-1)!.at(-1)!;
  const up = last.value >= first.value;
  const stroke = up ? "#22C55E" : "#EF4444";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <title>{dates?.length ? `${dates[0]} to ${dates.at(-1)}. ` : ""}Missing observations remain gaps.</title>
      {segments.map((segment) => segment.length === 1
        ? <circle key={segment[0].index} cx={segment[0].x} cy={segment[0].y} r={1.5} fill={stroke} />
        : <polyline key={segment[0].index} fill="none" stroke={stroke} strokeWidth="1.75" points={segment.map((point) => `${point.x},${point.y}`).join(" ")} />)}
    </svg>
  );
}
