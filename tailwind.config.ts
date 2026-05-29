import typography from "@tailwindcss/typography";
import type { Config } from "tailwindcss";

const config: Config = {
	darkMode: ["class"],
	content: ["./src/**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: {
				background: "var(--background)",
				foreground: "var(--foreground)",
				card: {
					DEFAULT: "var(--card)",
					foreground: "var(--card-foreground)",
				},
				popover: {
					DEFAULT: "var(--popover)",
					foreground: "var(--popover-foreground)",
				},
				primary: {
					DEFAULT: "var(--primary)",
					foreground: "var(--primary-foreground)",
					soft: "var(--primary-soft)",
					active: "var(--primary-active, #0c0a09)",
				},
				secondary: {
					DEFAULT: "var(--secondary)",
					foreground: "var(--secondary-foreground)",
				},
				muted: {
					DEFAULT: "var(--muted)",
					foreground: "var(--muted-foreground)",
				},
				accent: {
					DEFAULT: "var(--accent)",
					foreground: "var(--accent-foreground)",
					soft: "var(--accent-soft)",
				},
				destructive: {
					DEFAULT: "var(--destructive)",
					foreground: "var(--destructive-foreground)",
					soft: "var(--destructive-soft)",
				},
				border: "var(--border)",
				input: "var(--input)",
				ring: "var(--ring)",
				chart: {
					"1": "var(--chart-1)",
					"2": "var(--chart-2)",
					"3": "var(--chart-3)",
					"4": "var(--chart-4)",
					"5": "var(--chart-5)",
				},
				sidebar: {
					DEFAULT: "var(--sidebar-background)",
					foreground: "var(--sidebar-foreground)",
					primary: "var(--sidebar-primary)",
					"primary-foreground": "var(--sidebar-primary-foreground)",
					accent: "var(--sidebar-accent)",
					"accent-foreground": "var(--sidebar-accent-foreground)",
					border: "var(--sidebar-border)",
					ring: "var(--sidebar-ring)",
				},
				// Eisenhower quadrant colors
				"quadrant-do": "var(--quadrant-do)",
				"quadrant-do-soft": "var(--quadrant-do-soft)",
				"quadrant-schedule": "var(--quadrant-schedule)",
				"quadrant-schedule-soft": "var(--quadrant-schedule-soft)",
				"quadrant-delegate": "var(--quadrant-delegate)",
				"quadrant-delegate-soft": "var(--quadrant-delegate-soft)",
				"quadrant-eliminate": "var(--quadrant-eliminate)",
				"quadrant-eliminate-soft": "var(--quadrant-eliminate-soft)",
				// Status colors
				"status-not-started": "var(--status-not-started)",
				"status-in-progress": "var(--status-in-progress)",
				"status-done": "var(--status-done)",
				// Semantic colors
				success: {
					DEFAULT: "var(--success)",
					soft: "var(--success-soft)",
				},
				warning: {
					DEFAULT: "var(--warning)",
					soft: "var(--warning-soft)",
					ink: "var(--warning-ink)",
				},
				info: "var(--info)",
				// Backward compatibility aliases
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
				lg: "var(--radius, 8px)",
				xl: "12px",
				"2xl": "16px",
				"3xl": "24px",
				full: "9999px",
			},
			boxShadow: {
				// Backward compat: dramatic ambient (var-backed in globals.css)
				golden: "var(--shadow-golden-card, 0 4px 16px rgba(0, 0, 0, 0.04))",
				// Soft editorial elevation system
				"e-0": "none",
				"e-1": "0 1px 2px 0 rgb(0 0 0 / 0.04)",
				"e-2": "var(--shadow-golden-card, 0 4px 16px rgba(0, 0, 0, 0.04))",
				"e-3": "var(--shadow-golden-pop, 0 8px 24px rgba(0, 0, 0, 0.06))",
				"e-4": "var(--shadow-golden-dialog, 0 16px 48px rgba(0, 0, 0, 0.08))",
				"e-5": "var(--shadow-golden-toast, 0 24px 64px rgba(0, 0, 0, 0.10))",
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
				fast: "var(--motion-fast)",
				base: "var(--motion-base)",
				slow: "var(--motion-slow)",
			},
			zIndex: {
				sticky: "var(--z-sticky)",
				sidebar: "var(--z-sidebar)",
				overlay: "var(--z-overlay)",
				float: "var(--z-float)",
			},
		},
	},
	plugins: [typography],
};

export default config;
