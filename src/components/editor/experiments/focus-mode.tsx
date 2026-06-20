"use client";
import { useEffect, useRef } from "react";
import { useExperiment } from "@/stores/experiments-store";
import type { ExperimentProps } from "./index";

const focusCss = `
.tiptap > * {
	transition: opacity .35s ease;
}

.tiptap > .exp-focus-dim {
	opacity: .32;
}

.tiptap > .exp-focus-active {
	opacity: 1;
}

.tiptap > .exp-focus-context {
	opacity: .6;
}

body.exp-focus-cocoon .editorial-file-tree,
body.exp-focus-cocoon .editor-toolbar-scroll,
body.exp-focus-cocoon .editorial-doc-header,
body.exp-focus-cocoon aside[aria-label="AI Agent Panel"],
body.exp-focus-cocoon nav[aria-label="Document outline"],
body.exp-focus-cocoon button[aria-label="Collapse outline"],
body.exp-focus-cocoon button[aria-label="Expand outline"] {
	opacity: .45;
	transition: opacity .35s ease;
}
`;

function isHeadingElement(el: Element | null): el is HTMLElement {
	return el instanceof HTMLElement && /^H[1-6]$/.test(el.tagName);
}

export function FocusModeExperiment({ editor, scrollContainerRef }: ExperimentProps) {
	const on = useExperiment("focusMode");
	const rafRef = useRef<number | null>(null);
	const lastActiveIndexRef = useRef<number | null>(null);

	useEffect(() => {
		if (!on) return;

		const container = scrollContainerRef.current;
		const root = container?.querySelector<HTMLElement>(".tiptap");
		if (!container || !root) return;

		document.body.classList.add("exp-focus-cocoon");

		const clearClasses = () => {
			const currentRoot = scrollContainerRef.current?.querySelector<HTMLElement>(".tiptap");
			for (const child of Array.from(currentRoot?.children ?? [])) {
				child.classList.remove("exp-focus-active", "exp-focus-dim", "exp-focus-context");
			}
			document.body.classList.remove("exp-focus-cocoon");
			lastActiveIndexRef.current = null;
		};

		const updateFocus = () => {
			rafRef.current = null;

			const currentContainer = scrollContainerRef.current;
			const currentRoot = currentContainer?.querySelector<HTMLElement>(".tiptap");
			if (!currentContainer || !currentRoot) return;

			const blocks = Array.from(currentRoot.children).filter(
				(node): node is HTMLElement => node instanceof HTMLElement,
			);
			if (blocks.length === 0) return;

			const containerRect = currentContainer.getBoundingClientRect();
			const centerY = containerRect.top + containerRect.height / 2;

			let activeIndex = 0;
			let bestDistance = Number.POSITIVE_INFINITY;

			for (let i = 0; i < blocks.length; i++) {
				const block = blocks[i];
				const rect = block.getBoundingClientRect();
				let distance = 0;
				if (centerY < rect.top) distance = rect.top - centerY;
				else if (centerY > rect.bottom) distance = centerY - rect.bottom;

				if (distance < bestDistance) {
					bestDistance = distance;
					activeIndex = i;
					if (distance === 0) break;
				}
			}

			if (lastActiveIndexRef.current === activeIndex) return;
			lastActiveIndexRef.current = activeIndex;

			for (const block of blocks) {
				block.classList.remove("exp-focus-active", "exp-focus-dim", "exp-focus-context");
			}

			const activeStart = Math.max(0, activeIndex - 1);
			const activeEnd = Math.min(blocks.length - 1, activeIndex + 1);
			const activeBlock = blocks[activeIndex];
			const governingHeading = isHeadingElement(activeBlock)
				? activeBlock
				: (() => {
					for (let i = activeIndex - 1; i >= 0; i--) {
						if (isHeadingElement(blocks[i])) return blocks[i];
					}
					return null;
				})();
			const headingIndex = governingHeading ? blocks.indexOf(governingHeading) : -1;

			for (let i = 0; i < blocks.length; i++) {
				const block = blocks[i];
				const inActiveWindow = i >= activeStart && i <= activeEnd;
				const isContextHeading = i === headingIndex && !inActiveWindow;
				block.classList.toggle("exp-focus-active", inActiveWindow);
				block.classList.toggle("exp-focus-context", isContextHeading);
				block.classList.toggle("exp-focus-dim", !inActiveWindow && !isContextHeading);
			}
		};

		const scheduleUpdate = () => {
			if (rafRef.current !== null) return;
			rafRef.current = requestAnimationFrame(updateFocus);
		};

		scheduleUpdate();

		container.addEventListener("scroll", scheduleUpdate, { passive: true });
		window.addEventListener("resize", scheduleUpdate);
		editor?.on("update", scheduleUpdate);

		return () => {
			container.removeEventListener("scroll", scheduleUpdate);
			window.removeEventListener("resize", scheduleUpdate);
			editor?.off("update", scheduleUpdate);
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
			clearClasses();
		};
	}, [editor, on, scrollContainerRef]);

	return on ? <style>{focusCss}</style> : null;
}
