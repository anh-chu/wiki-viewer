import type { Metadata, Viewport } from "next";
import { Inter, Fraunces, Newsreader, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";

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

export const metadata: Metadata = {
	title: "Wiki Viewer",
	description: "Local file browser, viewer, and editor",
	manifest: "/manifest.webmanifest",
	appleWebApp: {
		capable: true,
		title: "Wiki",
		statusBarStyle: "black-translucent",
	},
	icons: {
		icon: "/icon-192.png",
		apple: "/icon-192.png",
	},
};

export const viewport: Viewport = {
	themeColor: "#0c0a09",
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				{/* No-flash skin script: sets data-skin before paint so editorial tokens apply immediately */}
				<script
					dangerouslySetInnerHTML={{
						__html: `(function(){try{var s=localStorage.getItem('wiki-skin');if(s==='editorial'){document.documentElement.setAttribute('data-skin','editorial');}}catch(e){}})();`,
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
