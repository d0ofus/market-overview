type Props = {
  values: number[] | null;
  width?: number;
  height?: number;
};

const BASE_BAR_COLOR = "#3347A8";
const LATEST_BAR_COLOR = "#DC2626";

export function HistogramSparkline({ values, width = 120, height = 28 }: Props) {
  if (!values?.length) {
    return <div className="flex h-7 w-[120px] items-center text-xs text-slate-500">-</div>;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const barSlotWidth = width / values.length;
  const gap = Math.max(1, Math.min(3, barSlotWidth * 0.25));
  const barWidth = Math.max(1, barSlotWidth - gap);
  const minBarHeight = 3;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label="Relative strength 30 day histogram">
      {values.map((value, index) => {
        const normalizedHeight = range === 0
          ? height * 0.6
          : minBarHeight + ((value - min) / range) * (height - minBarHeight);
        const x = index * barSlotWidth + gap / 2;
        const y = height - normalizedHeight;
        const isLatest = index === values.length - 1;
        return (
          <rect
            key={`${index}-${value}`}
            x={x}
            y={y}
            width={barWidth}
            height={normalizedHeight}
            rx={0.75}
            fill={isLatest ? LATEST_BAR_COLOR : BASE_BAR_COLOR}
          />
        );
      })}
    </svg>
  );
}
