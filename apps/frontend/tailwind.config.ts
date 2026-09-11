import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

export default {
  darkMode: ["class"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/auth-ui/src/**/*.{js,ts,jsx,tsx}",
    "../../packages/story-rail/src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/social-posts/src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        actions: {
          primary: "#3d4c6e",
          link: "#2563EB",
        },
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
          "1": "hsl(var(--chart-1))",
          "2": "hsl(var(--chart-2))",
          "3": "hsl(var(--chart-3))",
          "4": "hsl(var(--chart-4))",
          "5": "hsl(var(--chart-5))",
        },
      },
      screens: {
        "440": "440px",
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
      fontWeight: {
        regular: "400",
        medium: "500",
        bold: "700",
      },
      fontSize: {
        xxs: [
          "8px",
          {
            lineHeight: "auto",
          },
        ],
        xs: [
          "10px",
          {
            lineHeight: "16px",
          },
        ],
        sm: [
          "12px",
          {
            lineHeight: "20px",
          },
        ],
        base: [
          "14px",
          {
            lineHeight: "24px",
          },
        ],
        "base-custom": [
          "1.5rem",
          {
            lineHeight: "2rem",
          },
        ],
        lg: [
          "16px",
          {
            lineHeight: "28px",
          },
        ],
        xl: [
          "18px",
          {
            lineHeight: "24px",
          },
        ],
        "2xl": [
          "20px",
          {
            lineHeight: "32px",
          },
        ],
        "3xl": [
          "24px",
          {
            lineHeight: "36px",
          },
        ],
        "4xl": [
          "30px",
          {
            lineHeight: "auto",
          },
        ],
        "5xl": [
          "36px",
          {
            lineHeight: "auto",
          },
        ],
        "6xl": [
          "48px",
          {
            lineHeight: "auto",
          },
        ],
        "7xl": [
          "60px",
          {
            lineHeight: "auto",
          },
        ],
        "8xl": [
          "72px",
          {
            lineHeight: "auto",
          },
        ],
        "9xl": [
          "96px",
          {
            lineHeight: "auto",
          },
        ],
      },
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
    plugin(function ({ addUtilities }) {
      addUtilities({
        "@keyframes shimmer": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        ".animate-shimmer": {
          animation: "shimmer 2s infinite",
        },
        "@keyframes orb-drift-a": {
          "0%, 100%": { transform: "translate(0, 0) scale(1)" },
          "50%": { transform: "translate(22px, -18px) scale(1.08)" },
        },
        "@keyframes orb-drift-b": {
          "0%, 100%": { transform: "translate(0, 0) scale(1)" },
          "50%": { transform: "translate(-20px, 16px) scale(0.94)" },
        },
        "@keyframes orb-drift-c": {
          "0%, 100%": { transform: "translate(0, 0) scale(1)" },
          "50%": { transform: "translate(16px, 20px) scale(1.05)" },
        },
        ".animate-orb-drift-a": {
          animation: "orb-drift-a 14s ease-in-out infinite",
        },
        ".animate-orb-drift-b": {
          animation: "orb-drift-b 16s ease-in-out infinite",
        },
        ".animate-orb-drift-c": {
          animation: "orb-drift-c 18s ease-in-out infinite",
        },
        "@media (prefers-reduced-motion: reduce)": {
          ".animate-orb-drift-a, .animate-orb-drift-b, .animate-orb-drift-c": {
            animation: "none",
          },
        },
      });
    }),
  ],
} satisfies Config;
