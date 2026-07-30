import type { Metadata, Viewport } from "next";
import { Inter, Fraunces, Newsreader, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { apiUrl } from "@/lib/url-prefix";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const fraunces = Fraunces({
	subsets: ["latin"],
	variable: "--font-fraunces",
	axes: ["opsz"],
	display: "swap",
});
const newsreader = Newsreader({
	subsets: ["latin"],
	variable: "--font-newsreader",
	axes: ["opsz"],
	style: ["normal", "italic"],
	display: "swap",
});
const ibmPlexMono = IBM_Plex_Mono({
	subsets: ["latin"],
	variable: "--font-plex-mono",
	weight: ["400", "500", "600"],
	display: "swap",
});

// The root layout injects WIKI_URL_PREFIX / WIKI_LITE as browser globals below.
// Those are runtime values: lite is proxied under a prefix chosen by whoever
// starts it, not at build time. Without this the route is statically
// prerendered, process.env is read during `next build` where the vars are
// unset, and the HTML ships an empty prefix. Every client fetch then targets
// the origin root instead of the proxy prefix and 404s.
//
// The cost is negligible here: 73 of 77 routes are already dynamic.
export const dynamic = "force-dynamic";

// generateMetadata, not a static `metadata` export: the apiUrl() calls below
// need the runtime WIKI_URL_PREFIX. Next collects a static `metadata` object
// at build time, where the prefix is unset, so the manifest and icon hrefs
// shipped unprefixed and 404'd behind the lite reverse proxy.
export function generateMetadata(): Metadata {
	return {
		title: "Wiki Viewer",
		description: "Local file browser, viewer, and editor",
		manifest: apiUrl("/manifest.webmanifest"),
		appleWebApp: {
			capable: true,
			title: "Wiki",
			statusBarStyle: "black-translucent",
		},
		icons: {
			icon: apiUrl("/icon-192.png"),
			apple: apiUrl("/icon-192.png"),
		},
	};
}

export const viewport: Viewport = {
	themeColor: "#0c0a09",
	width: "device-width",
	initialScale: 1,
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				{/* WIKI_URL_PREFIX / WIKI_LITE globals injected before any module loads */}
				<script
					dangerouslySetInnerHTML={{
						__html: `window.__WIKI_PREFIX=${JSON.stringify(process.env.WIKI_URL_PREFIX ?? "")};window.__WIKI_LITE=${process.env.WIKI_LITE === "1"};`,
					}}
				/>
				{/* No-flash skin script: sets data-skin before paint so editorial tokens apply immediately */}
				<script
					dangerouslySetInnerHTML={{
						__html: `(function(){try{var s=localStorage.getItem('wiki-skin');if(s!=='default'){document.documentElement.setAttribute('data-skin','editorial');}}catch(e){}})();`,
					}}
				/>
			</head>
			<body className={`${inter.variable} ${fraunces.variable} ${newsreader.variable} ${ibmPlexMono.variable} font-sans antialiased`}>
				<ThemeProvider>
					{children}
					<Toaster
						theme="system"
						position="bottom-right"
						toastOptions={{
							className: "border-border bg-card text-card-foreground",
						}}
					/>
				</ThemeProvider>
			</body>
		</html>
	);
}
