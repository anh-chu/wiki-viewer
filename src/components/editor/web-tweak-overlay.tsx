"use client";

import { type RefObject } from "react";
import { TweakOverlay } from "./tweak/tweak-overlay";
import { useHtmlTweakAdapter } from "./tweak/adapters/html-adapter";

interface Props {
	frameRef: RefObject<HTMLIFrameElement | null>;
	path: string;
	enabled: boolean;
	onClose: () => void;
}

/**
 * HTML Tweak surface (web-tweak) — a thin mount of the shared
 * {@link TweakOverlay} driven by the HTML content-kind adapter.
 */
export function WebTweakOverlay({ frameRef, path, enabled, onClose }: Props) {
	const adapter = useHtmlTweakAdapter({ frameRef, path, enabled, onClose });
	return <TweakOverlay adapter={adapter} />;
}
