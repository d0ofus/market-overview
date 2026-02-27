type Props = {
  values: number[];
  width?: number;
  height?: number;
};

export function Sparkline({ values, width = 100, height = 26 }: Props) {
  if (!values.length) return <div className="h-6 w-24 rounded bg-slate-800" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / Math.max(1, values.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x},${y}`;
    })
    .join(" ");
  const up = values[values.length - 1] >= values[0];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline fill="none" stroke={up ? "#22C55E" : "#EF4444"} strokeWidth="1.75" points={points} />
    </svg>
  );
}
