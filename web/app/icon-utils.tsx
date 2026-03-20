import { ImageResponse } from "next/og";

type TabIconConfig = {
  label: string;
  bg: string;
  fg?: string;
  accent?: string;
};

export const iconSize = {
  width: 64,
  height: 64,
};

export const iconContentType = "image/png";

export function createTabIcon(config: TabIconConfig) {
  const fg = config.fg ?? "#f8fafc";
  const accent = config.accent ?? "rgba(248,250,252,0.18)";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          background: config.bg,
          color: fg,
          fontSize: 28,
          fontWeight: 800,
          letterSpacing: "-0.04em",
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `linear-gradient(135deg, transparent 0%, ${accent} 100%)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: 8,
            background: fg,
            opacity: 0.18,
          }}
        />
        <span style={{ display: "flex", position: "relative" }}>{config.label}</span>
      </div>
    ),
    iconSize,
  );
}
