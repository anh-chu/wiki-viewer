import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

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
			<body className={`${inter.variable} font-sans antialiased`}>
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
