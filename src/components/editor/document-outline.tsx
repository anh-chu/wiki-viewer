"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { List } from "lucide-react";
import { cn } from "@/lib/utils";

interface Heading {
	level: number;
	text: string;
	pos: number; // ProseMirror doc position (start of node)
	uid: string; // unique id within the doc (text + index dedup)
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

function getHeadingElement(editor: Editor, h: Heading): HTMLElement | null {
	try {
		const { node } = editor.view.domAtPos(h.pos + 1);
		return node.nodeType === Node.ELEMENT_NODE
			? (node as HTMLElement).closest("h1,h2,h3,h4,h5,h6") ?? (node as HTMLElement)
			: (node as Node).parentElement?.closest("h1,h2,h3,h4,h5,h6") ?? null;
	} catch {
		return null;
	}
}

const OUTLINE_OPEN_KEY = "kb-outline-pinned";

interface DocumentOutlineProps {
	editor: Editor | null;
	scrollContainerRef: React.RefObject<HTMLDivElement | null>;
	/** Controlled open state — the editor owns it so a change can re-measure. */
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function DocumentOutline({ editor, scrollContainerRef, open, onOpenChange }: DocumentOutlineProps) {
	const [headings, setHeadings] = useState<Heading[]>([]);
	const [activeUid, setActiveUid] = useState<string | null>(null);
	const [scrollProgress, setScrollProgress] = useState(0);
	const [sectionFill, setSectionFill] = useState(0);
	const headingsRef = useRef<Heading[]>([]);
	const activeUidRef = useRef<string | null>(null);
	const observerRef = useRef<IntersectionObserver | null>(null);

	useEffect(() => {
		headingsRef.current = headings;
	}, [headings]);

	useEffect(() => {
		activeUidRef.current = activeUid;
	}, [activeUid]);

	// Persist open state to localStorage
	useEffect(() => {
		try {
			localStorage.setItem(OUTLINE_OPEN_KEY, open ? "1" : "0");
		} catch {
			// quota / private-mode errors are non-fatal
		}
	}, [open]);

	// Extract headings on doc update, debounced. Walking the whole doc + rebuilding
	// the IntersectionObserver on every keystroke is wasteful; headings change
	// rarely, so a trailing 250ms debounce is imperceptible.
	useEffect(() => {
		if (!editor) return;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const update = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => setHeadings(extractHeadings(editor)), 250);
		};
		editor.on("update", update);
		setHeadings(extractHeadings(editor)); // initial, immediate
		return () => {
			if (timer) clearTimeout(timer);
			editor.off("update", update);
		};
	}, [editor]);

	// Reading-progress bar: track scroll on the scroll container
	useEffect(() => {
		const el = scrollContainerRef.current;
		if (!el) return;
		let rafId = 0;
		const onScroll = () => {
			cancelAnimationFrame(rafId);
			rafId = requestAnimationFrame(() => {
				const total = el.scrollHeight - el.clientHeight;
				setScrollProgress(total > 0 ? Math.min(1, el.scrollTop / total) : 0);

				const currentHeadings = headingsRef.current;
				const activeId = activeUidRef.current;
				if (!editor || !activeId || currentHeadings.length === 0) {
					setSectionFill(0);
					return;
				}

				const activeIndex = currentHeadings.findIndex((h) => h.uid === activeId);
				if (activeIndex < 0) {
					setSectionFill(0);
					return;
				}

				const activeHeading = currentHeadings[activeIndex];
				const nextHeading = currentHeadings[activeIndex + 1];
				const activeEl = getHeadingElement(editor, activeHeading);
				if (!activeEl) {
					setSectionFill(0);
					return;
				}

				const activeTop = activeEl.offsetTop;
				const nextTop = nextHeading ? getHeadingElement(editor, nextHeading)?.offsetTop ?? el.scrollHeight : el.scrollHeight;
				const span = Math.max(1, nextTop - activeTop);
				const marker = el.scrollTop + Math.min(96, el.clientHeight * 0.25);
				setSectionFill(Math.max(0, Math.min(1, (marker - activeTop) / span)));
			});
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			el.removeEventListener("scroll", onScroll);
			cancelAnimationFrame(rafId);
		};
	}, [editor, scrollContainerRef]);

	// Scroll-spy: observe heading DOM nodes
	useEffect(() => {
		observerRef.current?.disconnect();
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

		// Tag and observe each heading node via ProseMirror pos→DOM
		for (const h of headings) {
			try {
				const el = getHeadingElement(editor, h);
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
	}, [headings, editor, scrollContainerRef]);

	const scrollToHeading = useCallback(
		(h: Heading) => {
			if (!editor) return;
			const el = getHeadingElement(editor, h);
			if (el) {
				el.scrollIntoView({ behavior: "smooth", block: "start" });
				// Dispatch custom event for anchor-flash experiment
				document.dispatchEvent(
					new CustomEvent("anchor-navigation", {
						detail: { element: el },
					}),
				);
			}
		},
		[editor],
	);

	const showToc = headings.length >= 2;

	const headingList = (
		<>
			{headings.map((h, i) => (
				<button
					key={`${h.uid}-${i}`}
					onClick={() => {
						scrollToHeading(h);
					}}
					title={h.text}
					className={cn(
						"text-left text-[10.5px] leading-snug py-0.5 rounded truncate transition-colors shrink-0",
						activeUid === h.uid
							? "text-primary bg-primary/10 font-medium"
							: "text-muted-foreground/60 hover:text-foreground hover:bg-accent",
						activeUid === h.uid && "relative overflow-hidden",
					)}
					style={{ paddingLeft: `${(h.level - 1) * 8 + 4}px` }}
				>
					{activeUid === h.uid && (
						<span aria-hidden className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary/15">
							<span
								className="absolute bottom-0 left-0 w-full bg-primary transition-[height] duration-100 ease-out"
								style={{ height: `${sectionFill * 100}%` }}
							/>
						</span>
					)}
					{activeUid === h.uid ? <span className="relative z-10">{h.text}</span> : h.text}
				</button>
			))}
		</>
	);

	return (
		<>
			{/* Reading-progress bar — thin line at very top of editor area */}
			<div
				aria-hidden
				className="absolute top-0 left-0 right-0 h-0.5 z-30 pointer-events-none"
			>
				<div
					className="h-full bg-primary/35 transition-[width] duration-100 ease-out"
					style={{ width: `${scrollProgress * 100}%` }}
				/>
			</div>

			{/* TOC column — a pushed LEFT panel, the comments margin's model exactly:
			    a shrink-0 flex sibling that reserves its width out of the ROW (so it
			    can never cover text) and shows or hides as ONE state, with a corner
			    toggle when closed. No hover expansion, no overlay fallback. */}
			{showToc && open && (
				// pt-8 (32px) clears the breadcrumb bar at the row's top (6+16+6+1 border
				// = 29px) plus a small gap — nothing else; the padding is as short as
				// that overlay allows.
				<div
					className="relative z-10 flex w-40 shrink-0 self-stretch flex-col overflow-hidden border-r border-border bg-background pt-8"
					data-outline-margin
				>
					<div className="flex items-center justify-between gap-1 px-2 pb-1.5">
						<span className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
							<List className="h-3 w-3" />
							<span>Outline</span>
						</span>
						<button
							onClick={() => onOpenChange(false)}
							className="rounded px-1 py-0.5 text-[10px] text-muted-foreground/40 transition-colors hover:bg-accent hover:text-muted-foreground"
							aria-label="Collapse outline"
						>
							Hide
						</button>
					</div>
					<nav
						aria-label="Document outline"
						className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-2"
					>
						{headingList}
					</nav>
				</div>
			)}

			{/* Corner toggle when the column is closed — the annotations button's
			    pattern, at the opposite (left) corner. */}
			{showToc && !open && (
				<button
					onClick={() => onOpenChange(true)}
					className="absolute left-2 top-10 z-30 flex items-center gap-1 px-1.5 py-1 rounded bg-background/80 backdrop-blur border border-border/60 text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors text-[10px] shadow-sm"
					aria-label="Document outline"
					aria-expanded={false}
				>
					<List className="h-3.5 w-3.5" />
				</button>
			)}
		</>
	);
}
