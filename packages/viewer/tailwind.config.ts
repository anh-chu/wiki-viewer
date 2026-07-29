import typography from "@tailwindcss/typography";
import type { Config } from "tailwindcss";

/**
 * Colour tokens as FUNCTIONS, so the /opacity modifier actually works.
 *
 * Returning a plain "var(--wv-x)" string means Tailwind v3 cannot apply an alpha
 * modifier, and it silently emits NOTHING for bg-muted/50, border-border/50,
 * bg-primary/10 and the like. The package used 23 such utilities and every one of
 * them was a no-op: the CSV header lost its background, source-viewer rows lost
 * their hover tint, the outline lost its active highlight. Nothing errored, and no
 * audit that inspects what IS in the CSS could see it.
 *
 * The function form receives the modifier, so the alpha is applied with color-mix,
 * which composes correctly with tokens that are themselves color-mix expressions.
 * Without a modifier the output is byte-identical to the old plain var().
 */
const wv =
  (name: string) =>
  ({ opacityValue }: { opacityValue?: string } = {}): string => {
    const alpha = Number(opacityValue);
    if (opacityValue !== undefined && Number.isFinite(alpha) && alpha < 1) {
      return `color-mix(in oklab, var(--wv-${name}) ${alpha * 100}%, transparent)`;
    }
    return `var(--wv-${name})`;
  };

const config: Config = {
  darkMode: ["class"],
  // No global reset: the package ships a :where()-scoped reset instead, so it
  // cannot restyle the host app's elements.
  corePlugins: { preflight: false },
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: wv("background"),
        foreground: wv("foreground"),
        card: {
          DEFAULT: wv("card"),
          foreground: wv("card-foreground"),
        },
        popover: {
          DEFAULT: wv("popover"),
          foreground: wv("popover-foreground"),
        },
        primary: {
          DEFAULT: wv("primary"),
          foreground: wv("primary-foreground"),
          soft: wv("primary-soft"),
        },
        secondary: {
          DEFAULT: wv("secondary"),
          foreground: wv("secondary-foreground"),
        },
        muted: {
          DEFAULT: wv("muted"),
          foreground: wv("muted-foreground"),
        },
        accent: {
          DEFAULT: wv("accent"),
          foreground: wv("accent-foreground"),
          soft: wv("accent-soft"),
        },
        destructive: {
          DEFAULT: wv("destructive"),
          foreground: wv("destructive-foreground"),
          soft: wv("destructive-soft"),
        },
        border: wv("border"),
        input: wv("input"),
        ring: wv("ring"),
        overlay: wv("overlay"),
        sidebar: {
          DEFAULT: wv("sidebar-background"),
          foreground: wv("sidebar-foreground"),
          primary: wv("sidebar-primary"),
          "primary-foreground": wv("sidebar-primary-foreground"),
          accent: wv("sidebar-accent"),
          "accent-foreground": wv("sidebar-accent-foreground"),
          border: wv("sidebar-border"),
          ring: wv("sidebar-ring"),
        },
        success: {
          DEFAULT: wv("success"),
          soft: wv("success-soft"),
        },
        warning: {
          DEFAULT: wv("warning"),
          soft: wv("warning-soft"),
          ink: wv("warning-ink"),
        },
        info: wv("info"),
        mistral: {
          orange: "#292524",
          flame: "#0c0a09",
          black: "#0c0a09",
        },
        sunshine: {
          900: "#292524",
          700: "#4e4e4e",
          500: "#777169",
          300: "#a8a29e",
        },
      },
      borderRadius: {
        sm: "4px",
        md: "6px",
        lg: "var(--wv-radius)",
        xl: "12px",
        "2xl": "16px",
        "3xl": "24px",
        full: "9999px",
      },
      boxShadow: {
        golden: "var(--shadow-golden-card, 0 4px 16px rgba(0, 0, 0, 0.04))",
        "e-0": "none",
        "e-1": "0 1px 2px 0 rgb(0 0 0 / 0.04)",
        "e-2":
          "var(--shadow-golden-card, 0 4px 16px rgba(0, 0, 0, 0.04))",
        "e-3":
          "var(--shadow-golden-pop, 0 8px 24px rgba(0, 0, 0, 0.06))",
        "e-4":
          "var(--shadow-golden-dialog, 0 16px 48px rgba(0, 0, 0, 0.08))",
        "e-5":
          "var(--shadow-golden-toast, 0 24px 64px rgba(0, 0, 0, 0.10))",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        serif: ["Waldenburg", "EB Garamond", "Times New Roman", "serif"],
        display: ["var(--font-fraunces, Georgia)", "Georgia", "serif"],
        reading: ["var(--font-newsreader, Georgia)", "Georgia", "serif"],
        mono: [
          "var(--font-plex-mono, ui-monospace)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      fontSize: {
        "display-mega": [
          "64px",
          { lineHeight: "1.05", fontWeight: "300", letterSpacing: "-1.92px" },
        ],
        "display-xl": [
          "48px",
          { lineHeight: "1.08", fontWeight: "300", letterSpacing: "-0.96px" },
        ],
        "display-lg": [
          "36px",
          { lineHeight: "1.17", fontWeight: "300", letterSpacing: "-0.36px" },
        ],
        "display-md": [
          "32px",
          { lineHeight: "1.13", fontWeight: "300", letterSpacing: "-0.32px" },
        ],
        "display-sm": [
          "24px",
          { lineHeight: "1.2", fontWeight: "300", letterSpacing: "0" },
        ],
        "title-md": [
          "20px",
          { lineHeight: "1.35", fontWeight: "500", letterSpacing: "0" },
        ],
        "title-sm": [
          "18px",
          { lineHeight: "1.44", fontWeight: "500", letterSpacing: "0.18px" },
        ],
        "body-md": [
          "16px",
          { lineHeight: "1.5", fontWeight: "400", letterSpacing: "0.16px" },
        ],
        "body-sm": [
          "15px",
          { lineHeight: "1.47", fontWeight: "400", letterSpacing: "0.15px" },
        ],
        caption: [
          "14px",
          { lineHeight: "1.5", fontWeight: "400", letterSpacing: "0" },
        ],
        "caption-uppercase": [
          "12px",
          { lineHeight: "1.4", fontWeight: "600", letterSpacing: "0.96px" },
        ],
        button: [
          "15px",
          { lineHeight: "1", fontWeight: "500", letterSpacing: "0" },
        ],
        "nav-link": [
          "15px",
          { lineHeight: "1.4", fontWeight: "500", letterSpacing: "0" },
        ],
      },
      transitionDuration: {
        fast: "var(--wv-motion-fast)",
        base: "var(--wv-motion-base)",
        slow: "var(--wv-motion-slow)",
      },
      zIndex: {
        sticky: "var(--z-sticky, 10)",
        sidebar: "var(--z-sidebar, 30)",
        overlay: "var(--z-overlay, 40)",
        float: "var(--z-float, 50)",
      },
    },
  },
  plugins: [typography],
};

export default config;
