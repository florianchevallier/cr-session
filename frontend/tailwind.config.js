/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        paper: token("paper"),
        surface: token("surface"),
        sunken: token("sunken"),
        ink: {
          DEFAULT: token("ink"),
          muted: token("ink-muted"),
          subtle: token("ink-subtle"),
        },
        line: {
          DEFAULT: token("line"),
          strong: token("line-strong"),
          field: token("line-field"),
        },
        accent: {
          DEFAULT: token("accent"),
          hover: token("accent-hover"),
          soft: token("accent-soft"),
          ink: token("accent-ink"),
          on: token("on-accent"),
        },
        ok: { DEFAULT: token("ok"), soft: token("ok-soft") },
        warn: { DEFAULT: token("warn"), soft: token("warn-soft") },
        danger: { DEFAULT: token("danger"), soft: token("danger-soft") },
        scene: {
          narrative: token("scene-narrative"),
          combat: token("scene-combat"),
          social: token("scene-social"),
          exploration: token("scene-exploration"),
        },
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica Neue", "sans-serif"],
        serif: ["Charter", '"Iowan Old Style"', '"Sitka Text"', "Georgia", "Cambria", "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        // Modular scale: 12 / 14 / 16 / 18 / 22 / 28 / 36 / 44
        xs: ["0.75rem", { lineHeight: "1.125rem" }],
        sm: ["0.875rem", { lineHeight: "1.375rem" }],
        base: ["1rem", { lineHeight: "1.5rem" }],
        lg: ["1.125rem", { lineHeight: "1.75rem" }],
        xl: ["1.375rem", { lineHeight: "1.875rem" }],
        "2xl": ["1.75rem", { lineHeight: "2.25rem" }],
        "3xl": ["2.25rem", { lineHeight: "2.625rem" }],
        "4xl": ["2.75rem", { lineHeight: "3.125rem" }],
      },
      maxWidth: {
        prose: "68ch",
      },
      boxShadow: {
        card: "0 1px 2px rgb(var(--shadow) / 0.06), 0 1px 1px rgb(var(--shadow) / 0.04)",
        raised: "0 12px 32px -12px rgb(var(--shadow) / 0.28), 0 2px 6px rgb(var(--shadow) / 0.08)",
      },
    },
  },
  plugins: [],
};
