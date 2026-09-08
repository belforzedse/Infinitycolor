import type { Config } from "tailwindcss";

export default {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/auth-ui/src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        "infinity-primary": {
          DEFAULT: "#3d4c6e",
          darker: "#262f45",
          dark: "#33415e",
          light: "#566d97",
          lighter: "#aebfdb",
        },
        foreground: { primary: "#33415e", muted: "#64748b" },
        background: { form: "#ffffff" },
      },
      fontFamily: { "peyda-fanum": ["var(--font-peyda-fanum)"] },
      fontSize: {
        sm: ["12px", { lineHeight: "20px" }],
        base: ["14px", { lineHeight: "24px" }],
        lg: ["16px", { lineHeight: "28px" }],
        xl: ["18px", { lineHeight: "24px" }],
        "2xl": ["20px", { lineHeight: "32px" }],
        "4xl": ["30px", { lineHeight: "1.2" }],
      },
      borderRadius: {
        micro: "var(--radius-micro)",
        compact: "var(--radius-compact)",
        control: "var(--radius-control)",
        prominent: "var(--radius-prominent)",
        panel: "var(--radius-panel)",
        pill: "var(--radius-pill)",
      },
    },
  },
  plugins: [],
} satisfies Config;
