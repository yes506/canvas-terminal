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
      keyframes: {
        "toast-in": {
          "0%": { opacity: "0", transform: "translateY(-4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "toast-in": "toast-in 0.2s ease-out",
      },
    },
  },
  plugins: [],
} satisfies Config;
