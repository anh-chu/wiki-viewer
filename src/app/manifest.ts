import type { MetadataRoute } from "next";

/**
 * Web app manifest. Makes iOS/Android "Add to Home Screen" install a real
 * standalone PWA (display: standalone) with persistent storage, instead of a
 * plain bookmark. Without this, iOS treats the shortcut as ephemeral and evicts
 * its cookie jar, forcing re-login on every reopen.
 */
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "Wiki Viewer",
		short_name: "Wiki",
		description: "Local file browser, viewer, and editor",
		start_url: "/",
		scope: "/",
		display: "standalone",
		background_color: "#0c0a09",
		theme_color: "#0c0a09",
		icons: [
			{ src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
			{ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
			{
				src: "/icon-maskable-512.png",
				sizes: "512x512",
				type: "image/png",
				purpose: "maskable",
			},
		],
	};
}
