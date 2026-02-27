import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0B1118",
        panel: "#0F1722",
        panelSoft: "#121D2A",
        borderSoft: "#263445",
        text: "#E8EDF4",
        pos: "#22C55E",
        neg: "#EF4444",
        accent: "#38BDF8",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "SF Pro Display", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
