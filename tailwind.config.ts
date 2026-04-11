import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#1a1a1a",
          light: "#2a2a2a",
          lighter: "#3a3a3a",
        },
        accent: {
          DEFAULT: "#ffffff",
          dim: "#888888",
        },
        text: {
          DEFAULT: "#e0e0e0",
          muted: "#999999",
          dim: "#666666",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
