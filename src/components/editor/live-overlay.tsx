"use client";

import { type RefObject } from "react";
import { TweakOverlay } from "./tweak/tweak-overlay";
import {
	useMarkdownTweakAdapter,
	type MarkdownTarget,
} from "./tweak/adapters/markdown-adapter";

type Target = MarkdownTarget;
interface Props {
	path: string;
	target: Target | null;
	onClose: () => void;
	positions: Map<string, { top: number; left: number; width: number; bottom: number }>;
	scrollRef: RefObject<HTMLDivElement | null>;
	isViewing: boolean;
	baseRevision: number;
}

/**
 * Markdown Tweak surface — a thin mount of the shared {@link TweakOverlay}
 * driven by the markdown content-kind adapter (gather-then-Rewrite).
 */
export function LiveOverlay({ path, target, onClose, positions, scrollRef, isViewing, baseRevision }: Props) {
	const adapter = useMarkdownTweakAdapter({
		path,
		target,
		onClose,
		positions,
		scrollRef,
		isViewing,
		baseRevision,
	});
	return <TweakOverlay adapter={adapter} />;
}
