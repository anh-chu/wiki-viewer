"use client";

import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useWikiSlugsStore } from "@/stores/wiki-slugs-store";
import type { WikiCreateResult } from "./wiki-link-create-dialog";

interface WikiLinkPickerProps {
	editor: Editor | null;
	onCreateRequest: (slug: string) => Promise<WikiCreateResult>;
}

const SLUG_RE = /^[a-z0-9-]+$/;
const MAX_RESULTS = 20;

function fuzzyMatch(slug: string, query: string): boolean {
	if (!query) return true;
	return slug.includes(query.toLowerCase());
}

export function WikiLinkPicker({
	editor,
	onCreateRequest,
}: WikiLinkPickerProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [position, setPosition] = useState({ top: 0, left: 0 });
	const menuRef = useRef<HTMLDivElement>(null);

	// triggerFrom: doc position immediately after `[[` is fully inserted.
	// Calculated as `from + 1` at the moment the second `[` keydown fires.
	const triggerFromRef = useRef<number>(0);

	const slugs = useWikiSlugsStore((s) => s.slugs);
	const slugDir = useWikiSlugsStore((s) => s.slugDir);
	const has = useWikiSlugsStore((s) => s.has);

	const allSlugs = Array.from(slugs).sort();
	const filtered = allSlugs
		.filter((s) => fuzzyMatch(s, query))
		.slice(0, MAX_RESULTS);

	const canCreate = query.length > 0 && SLUG_RE.test(query) && !has(query);
	const totalItems = filtered.length + (canCreate ? 1 : 0);

	const handleClose = useCallback(() => {
		setOpen(false);
		setQuery("");
		setSelectedIndex(0);
	}, []);

	const insertWikiLink = useCallback(
		(slug: string) => {
			if (!editor) return;
			const { from } = editor.state.selection;
			// Delete the `[[query` range and replace with the wiki-link mark.
			const start = triggerFromRef.current - 2; // back over [[
			const markType = editor.state.schema.marks.wikiLink;
			if (!markType) return;
			const mark = markType.create({ slug, alias: null, anchor: null });
			const node = editor.state.schema.text(slug, [mark]);
			const tr = editor.state.tr.replaceWith(start, from, node);
			editor.view.dispatch(tr);
			editor.commands.focus();
			handleClose();
		},
		[editor, handleClose],
	);

	const handleSelect = useCallback(
		async (index: number) => {
			if (!editor) return;
			if (index < filtered.length) {
				insertWikiLink(filtered[index] ?? "");
			} else if (canCreate) {
				// Delegate to create dialog; insert mark on success.
				const result = await onCreateRequest(query);
				if (result.ok) {
					insertWikiLink(result.slug);
				} else {
					handleClose();
				}
			}
		},
		[
			editor,
			filtered,
			canCreate,
			query,
			insertWikiLink,
			onCreateRequest,
			handleClose,
		],
	);

	useEffect(() => {
		if (!editor) return;

		const handleKeyDown = (event: KeyboardEvent) => {
			if (!open) {
				// Detect second `[` — trigger is `[[`
				if (event.key === "[") {
					const { from } = editor.state.selection;
					const textBefore = editor.state.doc.textBetween(
						Math.max(0, from - 1),
						from,
					);
					if (textBefore !== "[") return;

					// Skip if cursor is inside an existing wikiLink mark
					const $pos = editor.state.doc.resolve(from);
					const insideWikiLink = $pos
						.marks()
						.some((m) => m.type.name === "wikiLink");
					if (insideWikiLink) return;

					const coords = editor.view.coordsAtPos(from);
					const editorRect = editor.view.dom.getBoundingClientRect();
					setPosition({
						top: coords.bottom - editorRect.top + 4,
						left: coords.left - editorRect.left,
					});
					// After keydown resolves, the second `[` will be inserted
					// moving the cursor to `from + 1`.
					triggerFromRef.current = from + 1;
					setOpen(true);
					setQuery("");
					setSelectedIndex(0);
				}
				return;
			}

			// Picker is open — handle navigation keys
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setSelectedIndex((i) => (totalItems > 0 ? (i + 1) % totalItems : 0));
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				setSelectedIndex((i) =>
					totalItems > 0 ? (i - 1 + totalItems) % totalItems : 0,
				);
			} else if (event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				if (totalItems > 0) {
					void handleSelect(selectedIndex);
				}
			} else if (event.key === "Escape") {
				handleClose();
			} else if (event.key === "]") {
				// Closing bracket dismisses without inserting
				handleClose();
			} else if (event.key === "Backspace") {
				if (query.length === 0) {
					handleClose();
				} else {
					setQuery((q) => q.slice(0, -1));
					setSelectedIndex(0);
				}
			} else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
				setQuery((q) => q + event.key);
				setSelectedIndex(0);
			}
		};

		window.addEventListener("keydown", handleKeyDown, true);
		return () => window.removeEventListener("keydown", handleKeyDown, true);
	}, [
		editor,
		open,
		query,
		selectedIndex,
		totalItems,
		handleClose,
		handleSelect,
	]);

	// Close on outside click
	useEffect(() => {
		if (!open) return;
		const handleMouseDown = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				handleClose();
			}
		};
		window.addEventListener("mousedown", handleMouseDown);
		return () => window.removeEventListener("mousedown", handleMouseDown);
	}, [open, handleClose]);

	if (!open || totalItems === 0) return null;

	return (
		<div
			ref={menuRef}
			className="absolute z-50 w-[280px] bg-popover border border-border rounded-lg shadow-lg py-1 overflow-hidden max-h-[300px] overflow-y-auto"
			style={{ top: position.top, left: position.left }}
		>
			{filtered.map((slug, i) => {
				const dir = slugDir.get(slug);
				return (
					<button
						key={slug}
						type="button"
						onMouseDown={(e) => {
							e.preventDefault();
							void handleSelect(i);
						}}
						onMouseEnter={() => setSelectedIndex(i)}
						className={cn(
							"flex items-center justify-between w-full px-3 py-1.5 text-left text-sm transition-colors",
							i === selectedIndex
								? "bg-accent text-accent-foreground"
								: "hover:bg-accent/50",
						)}
					>
						<span className="truncate">{slug}</span>
						{dir && (
							<span className="ml-2 shrink-0 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
								{dir}
							</span>
						)}
					</button>
				);
			})}

			{canCreate && (
				<button
					type="button"
					onMouseDown={(e) => {
						e.preventDefault();
						void handleSelect(filtered.length);
					}}
					onMouseEnter={() => setSelectedIndex(filtered.length)}
					className={cn(
						"flex items-center w-full px-3 py-1.5 text-left text-sm transition-colors",
						filtered.length === selectedIndex
							? "bg-accent text-accent-foreground"
							: "hover:bg-accent/50",
					)}
				>
					<span className="text-muted-foreground">
						+ Create new &ldquo;{query}&rdquo;
					</span>
				</button>
			)}
		</div>
	);
}
