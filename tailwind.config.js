/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["packages/core/src/**/*.{ts,tsx}"],
  important: ".roost-root",
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      fontSize: {
        "2xs": ["0.5rem", { lineHeight: "1" }],
        xs: ["0.625rem", { lineHeight: "1.4" }],
        sm: ["0.6875rem", { lineHeight: "1.45" }],
        base: ["0.8125rem", { lineHeight: "1.5" }],
        lg: ["0.875rem", { lineHeight: "1.4" }],
        xl: ["1rem", { lineHeight: "1.35" }],
      },
      borderRadius: {
        xs: "0.125rem",
        sm: "0.25rem",
        md: "0.375rem",
        lg: "0.5rem",
        xl: "0.75rem",
      },
      spacing: {
        sidebar: "220px",
        toolbar: "40px",
        "expanded-card": "500px",
        "card-px": "1rem",
        "card-py": "0.75rem",
        section: "0.75rem",
        grid: "0.75rem",
        "grid-lg": "2rem",
        "grid-xl": "2.5rem",
        inset: "0.75rem",
      },
      colors: {
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        background: "var(--background)",
        foreground: "var(--foreground)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        sync: "var(--sync)",
        pipeline: "var(--pipeline)",
        success: "var(--success)",
      },
    },
  },
};
