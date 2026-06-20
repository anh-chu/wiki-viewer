"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEditorStore } from "@/stores/editor-store";
import type { ExperimentProps } from "./index";

interface Heading {
	level: number;
	text: string;
	pos: number;
	uid: string;
	centerY: number;
	endLeft: number;
	rootRight: number;
}

function headingElement(editor: Editor, pos: number) {
	try {
		const { node } = editor.view.domAtPos(pos + 1);
		if (node.nodeType === Node.ELEMENT_NODE) {
			return (node as HTMLElement).closest("h1,h2,h3,h4,h5,h6") ?? (node as HTMLElement);
		}
		return (node as Node).parentElement?.closest("h1,h2,h3,h4,h5,h6") ?? null;
	} catch {
		return null;
	}
}

function extractHeadings(editor: Editor, host: HTMLElement): Heading[] {
	const headings: Heading[] = [];
	const seen = new Map<string, number>();
	const hostRect = host.getBoundingClientRect();
	const rootEl = host.querySelector(".tiptap") as HTMLElement | null;
	const rootRect = rootEl?.getBoundingClientRect();
	const rootRight = rootRect ? rootRect.right - hostRect.left + host.scrollLeft : hostRect.width;

	editor.state.doc.forEach((node, pos) => {
		if (node.type.name !== "heading") return;

		const text = node.textContent;
		const level = node.attrs.level as number;
		const base = text.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]/g, "") || "heading";
		const count = (seen.get(base) ?? 0) + 1;
		seen.set(base, count);
		const uid = count === 1 ? base : `${base}-${count}`;
		const el = headingElement(editor, pos);
		if (!(el instanceof HTMLElement)) return;

		let centerY = el.offsetTop + el.offsetHeight / 2;
		let endLeft = el.offsetLeft;

		try {
			const range = document.createRange();
			range.selectNodeContents(el);
			const r = range.getBoundingClientRect();
			const elRect = el.getBoundingClientRect();
			const box = r.width === 0 && r.height === 0 ? elRect : r;
			// ponytail: 0.6 (not 0.5) — serif line box reserves extra top ascent, glyph center sits below line-box center
			centerY = box.top - hostRect.top + host.scrollTop + box.height * 0.6;
			endLeft = box.right - hostRect.left + host.scrollLeft + 8;
		} catch {
			const elRect = el.getBoundingClientRect();
			centerY = elRect.top - hostRect.top + host.scrollTop + elRect.height / 2;
			endLeft = elRect.right - hostRect.left + host.scrollLeft + 8;
		}

		headings.push({ level, text, pos, uid, centerY, endLeft, rootRight });
	});

	return headings;
}

function restoreBlocks(host: HTMLElement | null) {
	const root = host?.querySelector(".tiptap") as HTMLElement | null;
	if (!root) return;
	for (const child of Array.from(root.children) as HTMLElement[]) {
		child.style.display = "";
	}
}

function headingLevel(el: Element | null) {
	if (!el) return null;
	const match = el.tagName.match(/^H([1-6])$/);
	return match ? Number(match[1]) : null;
}

function applyCollapsedState(editor: Editor, host: HTMLElement, headings: Heading[], collapsed: Set<string>) {
	const root = host.querySelector(".tiptap") as HTMLElement | null;
	if (!root) return;

	restoreBlocks(host);

	for (const heading of headings) {
		if (!collapsed.has(heading.uid)) continue;

		const el = headingElement(editor, heading.pos);
		if (!el || !root.contains(el)) continue;

		let current = el.nextElementSibling;
		while (current && current.parentElement === root) {
			const level = headingLevel(current);
			if (level !== null && level <= heading.level) break;
			(current as HTMLElement).style.display = "none";
			current = current.nextElementSibling;
		}
	}
}

export function CollapsibleExperiment({ editor, scrollContainerRef }: ExperimentProps) {
	const path = useEditorStore((s) => s.currentPath);
	const [ready, setReady] = useState(false);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [hydratedKey, setHydratedKey] = useState<string | null>(null);
	const [headings, setHeadings] = useState<Heading[]>([]);
	const storageKey = path ? `wiki-collapsed:${path}` : "wiki-collapsed:shared";
	const host = scrollContainerRef.current;

	useEffect(() => {
		setReady(true);
	}, []);

	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			const raw = localStorage.getItem(storageKey);
			if (!raw) {
				setCollapsed(new Set());
				setHydratedKey(storageKey);
				return;
			}
			const parsed = JSON.parse(raw) as unknown;
			if (Array.isArray(parsed)) {
				setCollapsed(new Set(parsed.filter((value): value is string => typeof value === "string")));
				setHydratedKey(storageKey);
				return;
			}
			setCollapsed(new Set());
			setHydratedKey(storageKey);
		} catch {
			setCollapsed(new Set());
			setHydratedKey(storageKey);
		}
	}, [storageKey]);

	useEffect(() => {
		if (typeof window === "undefined") return;
		if (hydratedKey !== storageKey) return;
		try {
			localStorage.setItem(storageKey, JSON.stringify(Array.from(collapsed)));
		} catch {
			// quota / privacy mode — non-fatal
		}
	}, [collapsed, hydratedKey, storageKey]);

	useEffect(() => {
		if (!editor || !ready || !host || hydratedKey !== storageKey) {
			restoreBlocks(host ?? null);
			setHeadings([]);
			return;
		}

		let timer: ReturnType<typeof setTimeout> | null = null;
		let rafId = 0;
		let resizeObserver: ResizeObserver | null = null;

		const compute = () => {
			const next = extractHeadings(editor, host);
			setHeadings(next);
			applyCollapsedState(editor, host, next, collapsed);
		};

		const update = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(compute, 250);
		};

		compute();
		rafId = requestAnimationFrame(compute);
		editor.on("update", update);
		window.addEventListener("resize", compute, { passive: true });

		if (typeof ResizeObserver !== "undefined") {
			resizeObserver = new ResizeObserver(compute);
			resizeObserver.observe(host);
		}

		return () => {
			if (timer) clearTimeout(timer);
			cancelAnimationFrame(rafId);
			editor.off("update", update);
			window.removeEventListener("resize", compute);
			resizeObserver?.disconnect();
			restoreBlocks(host);
		};
	}, [collapsed, editor, host, hydratedKey, ready, storageKey]);

	if (!ready) return null;
	if (!host) return null;

	return createPortal(
		<div aria-hidden className="absolute inset-0 h-0 pointer-events-none z-20">
			{headings.map((heading) => {
				const isCollapsed = collapsed.has(heading.uid);
				const lineLeft = heading.endLeft + 20;
				return (
					<div key={heading.uid}>
						<button
							type="button"
							aria-label={`${isCollapsed ? "Expand" : "Collapse"} section: ${heading.text}`}
							aria-pressed={isCollapsed}
							title={heading.text}
							onClick={() => {
								setCollapsed((prev) => {
									const next = new Set(prev);
									if (next.has(heading.uid)) next.delete(heading.uid);
									else next.add(heading.uid);
									return next;
								});
							}}
							className="pointer-events-auto absolute flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded border border-border/70 bg-background/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
							style={{ top: heading.centerY, left: heading.endLeft }}
						>
							{isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
						</button>
						{isCollapsed && heading.rootRight - lineLeft > 8 ? (
							<span
								aria-hidden
								className="absolute -translate-y-1/2 border-t border-dashed border-border/70"
								style={{ top: heading.centerY, left: lineLeft, width: heading.rootRight - lineLeft }}
							/>
						) : null}
					</div>
				);
			})}
		</div>,
		host,
	);
}
