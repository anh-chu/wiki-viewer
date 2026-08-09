"use client";

import { useEffect } from "react";
import type { ExperimentProps } from "./index";

const CSS = `
@keyframes exp-anchor-flash {
	0%, 18% {
		background: color-mix(in srgb, var(--primary) 40%, transparent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 45%, transparent);
	}
	100% {
		background: transparent;
		box-shadow: 0 0 0 2px transparent;
	}
}

.tiptap > .exp-anchor-flash {
	animation: exp-anchor-flash 2s ease-out;
	border-radius: 6px;
}
`;

export function AnchorFlashExperiment({ scrollContainerRef }: ExperimentProps) {
	useEffect(() => {
		const container = scrollContainerRef.current;
		if (!container) return;

		const active = new Set<HTMLElement>();
		const handlers = new WeakMap<HTMLElement, EventListener>();

		const clearFlash = (el: HTMLElement) => {
			el.classList.remove("exp-anchor-flash");
			const handler = handlers.get(el);
			if (handler) {
				el.removeEventListener("animationend", handler);
				handlers.delete(el);
			}
			active.delete(el);
		};

		const flash = (el: HTMLElement) => {
			const prev = handlers.get(el);
			if (prev) {
				el.removeEventListener("animationend", prev);
				handlers.delete(el);
			}

			el.classList.remove("exp-anchor-flash");
			void el.offsetWidth;
			el.classList.add("exp-anchor-flash");
			active.add(el);

			const done: EventListener = () => clearFlash(el);
			handlers.set(el, done);
			el.addEventListener("animationend", done, { once: true });
		};

		// Find element by fragment with proper URL-decoding
		const findElementByFragment = (fragment: string): HTMLElement | null => {
			let decodedId = fragment;
			try {
				decodedId = decodeURIComponent(fragment);
			} catch {
				// Invalid encoding; use as-is
			}

			// Iterate container's headings comparing element.id
			const headings = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
			for (const heading of headings) {
				if (heading.id === decodedId) {
					return heading as HTMLElement;
				}
			}

			// Fallback: try document.getElementById if element isn't in container's headings
			const direct = document.getElementById(decodedId);
			if (direct && container.contains(direct)) {
				return direct;
			}

			return null;
		};

		// Listen for explicit anchor navigation (hashchange, TOC click, wiki-link click)
		const onHashChange = () => {
			const hash = window.location.hash.slice(1);
			if (hash) {
				const target = findElementByFragment(hash);
				if (target) flash(target);
			}
		};

		const onAnchorFlash = (evt: Event) => {
			if (evt instanceof CustomEvent && evt.detail?.element instanceof HTMLElement) {
				flash(evt.detail.element);
			}
		};

		window.addEventListener("hashchange", onHashChange);
		document.addEventListener("anchor-navigation", onAnchorFlash);

		return () => {
			window.removeEventListener("hashchange", onHashChange);
			document.removeEventListener("anchor-navigation", onAnchorFlash);
			for (const el of active) clearFlash(el);
		};
	}, [scrollContainerRef]);

	return <style>{CSS}</style>;
}
