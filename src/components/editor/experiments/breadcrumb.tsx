"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { useExperiment } from "@/stores/experiments-store";
import type { ExperimentProps } from "./index";

interface Heading {
	level: number;
	text: string;
	pos: number;
	uid: string;
}

function extractHeadings(editor: Editor): Heading[] {
	const headings: Heading[] = [];
	const seen = new Map<string, number>();

	editor.state.doc.forEach((node, pos) => {
		if (node.type.name === "heading") {
			const text = node.textContent;
			const level = node.attrs.level as number;
			const base = text.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]/g, "") || "heading";
			const count = (seen.get(base) ?? 0) + 1;
			seen.set(base, count);
			const uid = count === 1 ? base : `${base}-${count}`;
			headings.push({ level, text, pos, uid });
		}
	});

	return headings;
}

export function BreadcrumbExperiment({ editor, scrollContainerRef }: ExperimentProps) {
	const on = useExperiment("breadcrumb");
	const [headings, setHeadings] = useState<Heading[]>([]);
	const [activeUid, setActiveUid] = useState<string | null>(null);
	const [scrolled, setScrolled] = useState(false);
	const observerRef = useRef<IntersectionObserver | null>(null);

	useEffect(() => {
		if (!on || !editor) return;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const update = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => setHeadings(extractHeadings(editor)), 250);
		};
		editor.on("update", update);
		setHeadings(extractHeadings(editor));
		return () => {
			if (timer) clearTimeout(timer);
			editor.off("update", update);
		};
	}, [on, editor]);

	useEffect(() => {
		if (!on) return;
		const el = scrollContainerRef.current;
		if (!el) return;
		let rafId = 0;
		const onScroll = () => {
			cancelAnimationFrame(rafId);
			rafId = requestAnimationFrame(() => {
				setScrolled(el.scrollTop > 40);
			});
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		onScroll();
		return () => {
			el.removeEventListener("scroll", onScroll);
			cancelAnimationFrame(rafId);
		};
	}, [on, scrollContainerRef]);

	useEffect(() => {
		observerRef.current?.disconnect();
		if (!on) return;
		const container = scrollContainerRef.current;
		if (!container || !editor || headings.length === 0) return;

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						const uid = (entry.target as HTMLElement).dataset.outlineId;
						if (uid) setActiveUid(uid);
					}
				}
			},
			{ root: container, rootMargin: "-8% 0px -72% 0px", threshold: 0 },
		);

		for (const h of headings) {
			try {
				const { node } = editor.view.domAtPos(h.pos + 1);
				const el: HTMLElement | null =
					node.nodeType === Node.ELEMENT_NODE
						? (node as HTMLElement).closest("h1,h2,h3,h4,h5,h6") ?? (node as HTMLElement)
						: (node as Node).parentElement?.closest("h1,h2,h3,h4,h5,h6") ?? null;
				if (el) {
					el.dataset.outlineId = h.uid;
					observer.observe(el);
				}
			} catch {
				// pos might be out of range during transition — skip
			}
		}

		observerRef.current = observer;
		return () => {
			observer.disconnect();
		};
	}, [on, editor, headings, scrollContainerRef]);

	const scrollToHeading = useCallback(
		(h: Heading) => {
			if (!editor) return;
			try {
				const { node } = editor.view.domAtPos(h.pos + 1);
				const el: HTMLElement | null =
					node.nodeType === Node.ELEMENT_NODE
						? (node as HTMLElement).closest("h1,h2,h3,h4,h5,h6") ?? (node as HTMLElement)
						: (node as Node).parentElement?.closest("h1,h2,h3,h4,h5,h6") ?? null;
				el?.scrollIntoView({ behavior: "smooth", block: "start" });
			} catch {
				// ignore
			}
		},
		[editor],
	);

	const trail = useMemo(() => {
		if (!activeUid || headings.length === 0) return [] as Heading[];
		const activeIndex = headings.findIndex((h) => h.uid === activeUid);
		if (activeIndex < 0) return [] as Heading[];

		const stack: Heading[] = [];
		for (let i = 0; i <= activeIndex; i += 1) {
			const h = headings[i];
			while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
			stack.push(h);
		}
		return stack;
	}, [activeUid, headings]);

	if (!on) return null;
	if (!scrolled || trail.length === 0) return null;

	return (
		<div className="absolute top-0 inset-x-0 z-20 bg-background/80 backdrop-blur border-b border-border/50 text-xs text-muted-foreground px-4 py-1.5 pr-4 xl:pr-44 pointer-events-none">
			<div className="flex items-center gap-1 overflow-hidden whitespace-nowrap">
				{trail.map((h, i) => {
					const isLast = i === trail.length - 1;
					return (
						<div
							key={`${h.uid}-${i}`}
							className={`flex items-center gap-1 ${isLast ? "min-w-0" : "shrink-0"}`}
						>
							{i > 0 && <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />}
							<button
								type="button"
								onClick={() => scrollToHeading(h)}
								title={h.text}
								className={`pointer-events-auto rounded px-1 py-0.5 hover:text-foreground hover:bg-accent/60 transition-colors ${
									isLast ? "truncate min-w-0" : "whitespace-nowrap"
								}`}
							>
								{h.text}
							</button>
						</div>
					);
				})}
			</div>
		</div>
	);
}
