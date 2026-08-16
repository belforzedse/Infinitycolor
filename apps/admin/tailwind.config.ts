import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

export default {
  darkMode: ["class"],
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/brand/src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        actions: { primary: "#3d4c6e", link: "#2563EB" },
        "infinity-primary": {
          DEFAULT: "#3d4c6e",
          foreground: "#ffffff",
          darker: "#262f45",
          dark: "#33415e",
          light: "#566d97",
          lighter: "#aebfdb",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        chart: {
          1: "hsl(var(--chart-1))",
          2: "hsl(var(--chart-2))",
          3: "hsl(var(--chart-3))",
          4: "hsl(var(--chart-4))",
          5: "hsl(var(--chart-5))",
        },
      },
      screens: {
        440: "440px",
        sm: "640px",
        md: "768px",
        tablet: "900px",
        sl: "1000px",
        lg: "1024px",
        xl: "1280px",
        "2xl": "1536px",
        "3xl": "1920px",
        "4xl": "2560px",
      },
      fontFamily: {
        "peyda-fanum": ["var(--font-peyda-fanum)"],
        peyda: ["var(--font-peyda)"],
        rokh: ["var(--font-rokh)"],
        kaghaz: ["var(--font-kaghaz)"],
      },
      fontWeight: { regular: "400", medium: "500", bold: "700" },
      borderRadius: {
        micro: "var(--radius-micro)",
        compact: "var(--radius-compact)",
        control: "var(--radius-control)",
        prominent: "var(--radius-prominent)",
        panel: "var(--radius-panel)",
        pill: "var(--radius-pill)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [
    require("tailwind-scrollbar")({
      nocompatible: true,
      themeKey: "scrollbar",
    }),
    require("tailwindcss-animate"),
    require("@tailwindcss/typography"),
    plugin(({ addUtilities }) => {
      addUtilities({
        "@keyframes shimmer": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        ".animate-shimmer": { animation: "shimmer 2s infinite" },
      });
    }),
  ],
} satisfies Config;
