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
		const headings = ".tiptap > :is(h1,h2,h3,h4,h5,h6)";
		let settleTimer: ReturnType<typeof setTimeout> | null = null;
		let rafId = 0;

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

		const findHeadingNearTop = () => {
			const containerTop = container.getBoundingClientRect().top;
			let best: HTMLElement | null = null;
			let bestDelta = Number.POSITIVE_INFINITY;

			// Headings have scroll-margin-top: 48px (globals.css), so a jump lands the
			// heading ~48px below the container top, clearing the sticky breadcrumb bar.
			const landing = 48;
			for (const node of container.querySelectorAll(headings)) {
				const el = node as HTMLElement;
				const delta = el.getBoundingClientRect().top - containerTop;
				const off = Math.abs(delta - landing);
				if (off <= 14 && off < bestDelta) {
					best = el;
					bestDelta = off;
				}
			}

			return best;
		};

		const settle = () => {
			settleTimer = null;
			const heading = findHeadingNearTop();
			if (heading) flash(heading);
		};

		const onScroll = () => {
			if (rafId) return;
			rafId = requestAnimationFrame(() => {
				rafId = 0;
				if (settleTimer) clearTimeout(settleTimer);
				settleTimer = setTimeout(settle, 140);
			});
		};

		container.addEventListener("scroll", onScroll, { passive: true });

		return () => {
			container.removeEventListener("scroll", onScroll);
			if (rafId) cancelAnimationFrame(rafId);
			if (settleTimer) clearTimeout(settleTimer);
			for (const el of active) clearFlash(el);
		};
	}, [scrollContainerRef]);

	return <style>{CSS}</style>;
}
