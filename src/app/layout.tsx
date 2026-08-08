import type { Metadata, Viewport } from "next";
import { Inter, Fraunces, Newsreader, IBM_Plex_Mono, Roboto, Open_Sans, Lexend, Atkinson_Hyperlegible, Merriweather, Libre_Baskerville } from "next/font/google";
import localFont from "next/font/local";
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

const roboto = Roboto({
	subsets: ["latin"],
	variable: "--font-roboto",
	weight: ["300", "400", "500", "700"],
	display: "swap",
});

const openSans = Open_Sans({
	subsets: ["latin"],
	variable: "--font-open-sans",
	display: "swap",
});

const lexend = Lexend({
	subsets: ["latin"],
	variable: "--font-lexend",
	display: "swap",
});

const atkinsonHyperlegible = Atkinson_Hyperlegible({
	subsets: ["latin"],
	variable: "--font-atkinson-hyperlegible",
	weight: ["400", "700"],
	style: ["normal", "italic"],
	display: "swap",
});

// Elms Sans, Stack Sans Notch, and Stack Sans Text are self-hosted via next/font/local
// instead of next/font/google. Each only ships a single static weight on Google Fonts
// (500/700 requests resolve to the same file as 400), and self-hosting sidesteps
// next/font/google's fallback-metrics lookup, which has no entry for these very new
// families and otherwise logs a noisy "Failed to find font override values" warning.
const elmsSans = localFont({
	src: "../../public/fonts/elms-sans/elms-sans-regular.woff2",
	weight: "400",
	variable: "--font-elms-sans",
	display: "swap",
});

const stackSansNotch = localFont({
	src: "../../public/fonts/stack-sans-notch/stack-sans-notch-regular.woff2",
	weight: "400",
	variable: "--font-stack-sans-notch",
	display: "swap",
});

const stackSansText = localFont({
	src: "../../public/fonts/stack-sans-text/stack-sans-text-regular.woff2",
	weight: "400",
	variable: "--font-stack-sans-text",
	display: "swap",
});

// Datatype and Miranda Sans are not in this Next.js version's bundled next/font/google
// snapshot yet, so they're self-hosted the same way as the Fontshare fonts below.
const datatype = localFont({
	src: "../../public/fonts/datatype/datatype-regular.woff2",
	weight: "400",
	variable: "--font-datatype",
	display: "swap",
});

const mirandaSans = localFont({
	src: "../../public/fonts/miranda-sans/miranda-sans-regular.woff2",
	weight: "400",
	variable: "--font-miranda-sans",
	display: "swap",
});

// Luciole (CC-BY 4.0, Laurent Bourcellier & Jonathan Perez) — designed for low-vision
// readability. Self-hosted from the official webfont kit (not on next/font/google).
const luciole = localFont({
	src: [
		{
			path: "../../public/fonts/luciole/luciole-regular.woff2",
			weight: "400",
			style: "normal",
		},
		{
			path: "../../public/fonts/luciole/luciole-italic.woff2",
			weight: "400",
			style: "italic",
		},
		{
			path: "../../public/fonts/luciole/luciole-bold.woff2",
			weight: "700",
			style: "normal",
		},
		{
			path: "../../public/fonts/luciole/luciole-bolditalic.woff2",
			weight: "700",
			style: "italic",
		},
	],
	variable: "--font-luciole",
	display: "swap",
});

const merriweather = Merriweather({
	subsets: ["latin"],
	variable: "--font-merriweather",
	weight: ["300", "400", "700", "900"],
	style: ["normal", "italic"],
	display: "swap",
});

const libreBaskerville = Libre_Baskerville({
	subsets: ["latin"],
	variable: "--font-libre-baskerville",
	weight: ["400", "700"],
	style: ["normal", "italic"],
	display: "swap",
});

// New fonts from Fontshare (self-hosted via next/font/local)
const satoshi = localFont({
	src: [
		{
			path: "../../public/fonts/satoshi/WNDVG7O66ENLOD43GS7FBUCC4KMT5OM2.woff2",
			weight: "300",
		},
		{
			path: "../../public/fonts/satoshi/KFIAZD4RUMEZIYV6FQ3T3GP5PDBDB6JY.woff2",
			weight: "400",
		},
		{
			path: "../../public/fonts/satoshi/7AHDUZ4A7LFLVFUIFSARGIWCRQJHISQP.woff2",
			weight: "500",
		},
		{
			path: "../../public/fonts/satoshi/GHM6WVH6MILNYOOCXHXB5GTSGNTMGXZR.woff2",
			weight: "700",
		},
		{
			path: "../../public/fonts/satoshi/J64QX5IPOHK56I2KYUNBQ5M2XWZEYKYX.woff2",
			weight: "900",
		},
	],
	variable: "--font-satoshi",
	display: "swap",
});

const generalSans = localFont({
	src: [
		{
			path: "../../public/fonts/general-sans/TW4KNQIPR4LNP4I6I6C6HKQ23B2EQAU5.woff2",
			weight: "300",
		},
		{
			path: "../../public/fonts/general-sans/7YY3ZAAE3TRV2LANYOLXNHTPHLXVWTKH.woff2",
			weight: "400",
		},
		{
			path: "../../public/fonts/general-sans/SB2OEB6IKZPRR6JT4GFJ2TFT6HBB6AZN.woff2",
			weight: "500",
		},
		{
			path: "../../public/fonts/general-sans/3ZLMEXZEQPLTEPMHTQDAUXP5ZZXCZAEN.woff2",
			weight: "600",
		},
		{
			path: "../../public/fonts/general-sans/NIQ54PVBBIWVK3PFSOIOUJSXIJ5WTNDP.woff2",
			weight: "700",
		},
	],
	variable: "--font-general-sans",
	display: "swap",
});

const sentient = localFont({
	src: [
		{
			path: "../../public/fonts/sentient/SIH66VPT4WS2HIF5PEJNDU4INNUF54LG.woff2",
			weight: "400",
		},
		{
			path: "../../public/fonts/sentient/RNUZPHMIVMPXFHVACRGCAJ32E6WUEDVU.woff2",
			weight: "500",
		},
		{
			path: "../../public/fonts/sentient/433XP6QWDVL6KQ5K7ZCOP524TX4LE4RJ.woff2",
			weight: "700",
		},
	],
	variable: "--font-sentient",
	display: "swap",
});

const gambetta = localFont({
	src: [
		{
			path: "../../public/fonts/gambetta/ODDSCHC7OZCRRQJDJV5LMJKTGF7URFO4.woff2",
			weight: "400",
		},
		{
			path: "../../public/fonts/gambetta/UMQTMTAEPCAFNEJDVEURBIXJENGOHOWO.woff2",
			weight: "500",
		},
		{
			path: "../../public/fonts/gambetta/6KRVTMHEY26GBVOWXYL6F3ZLGUXE5ZD5.woff2",
			weight: "600",
		},
		{
			path: "../../public/fonts/gambetta/RMBKFTS6UFOXVBCL3EVCXLWRQBA3PN4K.woff2",
			weight: "700",
		},
	],
	variable: "--font-gambetta",
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
		<html
			lang="en"
			suppressHydrationWarning
			className={`${inter.variable} ${fraunces.variable} ${newsreader.variable} ${ibmPlexMono.variable} ${satoshi.variable} ${generalSans.variable} ${sentient.variable} ${gambetta.variable} ${roboto.variable} ${openSans.variable} ${lexend.variable} ${atkinsonHyperlegible.variable} ${elmsSans.variable} ${stackSansNotch.variable} ${stackSansText.variable} ${datatype.variable} ${mirandaSans.variable} ${luciole.variable} ${merriweather.variable} ${libreBaskerville.variable}`}
		>
			<head>
				{/* WIKI_URL_PREFIX / WIKI_LITE globals injected before any module loads */}
				<script
					dangerouslySetInnerHTML={{
						__html: `window.__WIKI_PREFIX=${JSON.stringify(process.env.WIKI_URL_PREFIX ?? "")};window.__WIKI_LITE=${process.env.WIKI_LITE === "1"};`,
					}}
				/>
				{/* No-flash fonts script: sets font attributes before paint */}
				<script
					dangerouslySetInnerHTML={{
						__html: `(function(){try{var f=localStorage.getItem('wiki-fonts');if(f){try{var p=JSON.parse(f);var html=document.documentElement;if(p.ui){html.dataset.fontUi=p.ui;}if(p.body){html.dataset.fontBody=p.body;}if(p.heading){html.dataset.fontHeading=p.heading;}var isScale=function(v){return typeof v==='number'&&v>=0.5&&v<=2;};if(isScale(p.uiScale)){html.style.setProperty('--font-scale-ui',String(p.uiScale));}if(isScale(p.bodyScale)){html.style.setProperty('--font-scale-body',String(p.bodyScale));}if(isScale(p.headingScale)){html.style.setProperty('--font-scale-heading',String(p.headingScale));}}catch(e){}}}catch(e){}})();`,
					}}
				/>
			</head>
			<body className="font-sans antialiased">
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
