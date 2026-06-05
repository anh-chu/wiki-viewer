"use client";

import type { Editor } from "@tiptap/react";
import {
	AlertTriangle,
	CheckSquare,
	Code,
	File,
	Heading1,
	Heading2,
	Heading3,
	ImageIcon,
	Info,
	List,
	ListOrdered,
	Minus,
	Quote,
	Sigma,
	Table,
	Type,
	Video,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor-store";
import { type MediaKind, MediaPopover } from "./media-popover";

type PopoverKind = null | { type: "media"; kind: MediaKind };

interface SlashCommand {
	label: string;
	icon: React.ComponentType<{ className?: string }>;
	description: string;
	category: "basic" | "media" | "advanced";
	action:
		| { type: "direct"; run: (editor: Editor) => void }
		| { type: "popover"; kind: Exclude<PopoverKind, null> };
}

const commands: SlashCommand[] = [
	// Basic
	{
		label: "Text",
		icon: Type,
		description: "Start writing plain text",
		category: "basic",
		action: {
			type: "direct",
			run: (editor) => editor.chain().focus().setParagraph().run(),
		},
	},
	{
		label: "Heading 1",
		icon: Heading1,
		description: "Large section heading",
		category: "basic",
		action: {
			type: "direct",
			run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
		},
	},
	{
		label: "Heading 2",
		icon: Heading2,
		description: "Medium section heading",
		category: "basic",
		action: {
			type: "direct",
			run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
		},
	},
	{
		label: "Heading 3",
		icon: Heading3,
		description: "Small section heading",
		category: "basic",
		action: {
			type: "direct",
			run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
		},
	},
	{
		label: "Bullet List",
		icon: List,
		description: "Create a bullet list",
		category: "basic",
		action: {
			type: "direct",
			run: (editor) => editor.chain().focus().toggleBulletList().run(),
		},
	},
	{
		label: "Numbered List",
		icon: ListOrdered,
		description: "Create a numbered list",
		category: "basic",
		action: {
			type: "direct",
			run: (editor) => editor.chain().focus().toggleOrderedList().run(),
		},
	},
	{
		label: "Checklist",
		icon: CheckSquare,
		description: "Create a task checklist",
		category: "basic",
		action: {
			type: "direct",
			run: (editor) => editor.chain().focus().toggleTaskList().run(),
		},
	},
	{
		label: "Code Block",
		icon: Code,
		description: "Insert a code block",
		category: "basic",
		action: {
			type: "direct",
			run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
		},
	},
	{
		label: "Blockquote",
		icon: Quote,
		description: "Insert a blockquote",
		category: "basic",
		action: {
			type: "direct",
			run: (editor) => editor.chain().focus().toggleBlockquote().run(),
		},
	},
	{
		label: "Divider",
		icon: Minus,
		description: "Insert a horizontal rule",
		category: "basic",
		action: {
			type: "direct",
			run: (editor) => editor.chain().focus().setHorizontalRule().run(),
		},
	},
	{
		label: "Table",
		icon: Table,
		description: "Insert a 3x3 table",
		category: "basic",
		action: {
			type: "direct",
			run: (editor) =>
				editor
					.chain()
					.focus()
					.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
					.run(),
		},
	},

	// Media
	{
		label: "Image",
		icon: ImageIcon,
		description: "Upload, paste URL, or drop an image",
		category: "media",
		action: { type: "popover", kind: { type: "media", kind: "image" } },
	},
	{
		label: "Video",
		icon: Video,
		description: "Upload or paste a video URL",
		category: "media",
		action: { type: "popover", kind: { type: "media", kind: "video" } },
	},
	{
		label: "File",
		icon: File,
		description: "Attach any file to this page",
		category: "media",
		action: { type: "popover", kind: { type: "media", kind: "file" } },
	},

	// Advanced
	{
		label: "Callout",
		icon: Info,
		description: "Insert an info callout",
		category: "advanced",
		action: {
			type: "direct",
			run: (editor) =>
				editor.chain().focus().wrapIn("callout", { type: "info" }).run(),
		},
	},
	{
		label: "Warning",
		icon: AlertTriangle,
		description: "Insert a warning callout",
		category: "advanced",
		action: {
			type: "direct",
			run: (editor) =>
				editor.chain().focus().wrapIn("callout", { type: "warning" }).run(),
		},
	},
	{
		label: "Math",
		icon: Sigma,
		description: "Insert a LaTeX math expression",
		category: "advanced",
		action: {
			type: "direct",
			run: (editor) => editor.chain().focus().insertContent("$x=y$").run(),
		},
	},
];

/** Small static preview rendered at the bottom of the menu for the focused command. */
function CommandPreview({ cmd }: { cmd: SlashCommand }) {
	switch (cmd.label) {
		case "Heading 1":
			return (
				<p className="font-bold text-[18px] leading-tight text-foreground/80 truncate">
					Heading 1
				</p>
			);
		case "Heading 2":
			return (
				<p className="font-semibold text-[14px] leading-tight text-foreground/80 truncate">
					Heading 2
				</p>
			);
		case "Heading 3":
			return (
				<p className="font-medium text-[12px] leading-tight text-foreground/80 truncate">
					Heading 3
				</p>
			);
		case "Text":
			return (
				<p className="text-[11px] text-foreground/60 leading-snug">
					The quick brown fox jumps over the lazy dog.
				</p>
			);
		case "Bullet List":
			return (
				<ul className="list-disc pl-4 text-[10px] text-foreground/60 space-y-0.5">
					<li>First item</li>
					<li>Second item</li>
					<li>Third item</li>
				</ul>
			);
		case "Numbered List":
			return (
				<ol className="list-decimal pl-4 text-[10px] text-foreground/60 space-y-0.5">
					<li>First item</li>
					<li>Second item</li>
					<li>Third item</li>
				</ol>
			);
		case "Checklist":
			return (
				<div className="space-y-0.5 text-[10px] text-foreground/60">
					<div className="flex items-center gap-1.5">
						<span className="w-3 h-3 border border-foreground/30 rounded-sm inline-block shrink-0" />
						Pending task
					</div>
					<div className="flex items-center gap-1.5">
						<span className="w-3 h-3 border border-foreground/30 rounded-sm bg-foreground/20 inline-block shrink-0" />
						Done task
					</div>
				</div>
			);
		case "Code Block":
			return (
				<pre className="bg-muted rounded px-2 py-1 text-[10px] font-mono text-foreground/70 leading-snug">
					<code>{"const x = 42;"}</code>
				</pre>
			);
		case "Blockquote":
			return (
				<div className="border-l-2 border-foreground/30 pl-2 text-[10px] text-foreground/60 italic">
					A thought worth quoting.
				</div>
			);
		case "Divider":
			return <hr className="border-foreground/20 w-full" />;
		case "Table":
			return (
				<table className="text-[9px] border-collapse w-full">
					<thead>
						<tr>
							{["Col A", "Col B", "Col C"].map((h) => (
								<th
									key={h}
									className="border border-foreground/20 px-1.5 py-0.5 text-left font-semibold bg-muted/50 text-foreground/70"
								>
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{[["1", "2", "3"], ["4", "5", "6"]].map((row, i) => (
							<tr key={i}>
								{row.map((cell, j) => (
									<td
										key={j}
										className="border border-foreground/20 px-1.5 py-0.5 text-foreground/50"
									>
										{cell}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			);
		case "Image":
			return (
				<div className="flex items-center gap-2 text-foreground/50">
					<ImageIcon className="h-8 w-8 text-foreground/20" />
					<span className="text-[10px]">image.png</span>
				</div>
			);
		case "Video":
			return (
				<div className="flex items-center gap-2 text-foreground/50">
					<Video className="h-8 w-8 text-foreground/20" />
					<span className="text-[10px]">video.mp4</span>
				</div>
			);
		case "File":
			return (
				<div className="flex items-center gap-2 text-foreground/50">
					<File className="h-8 w-8 text-foreground/20" />
					<span className="text-[10px]">attachment.pdf</span>
				</div>
			);
		case "Callout":
			return (
				<div className="flex items-start gap-1.5 bg-blue-500/10 border border-blue-500/20 rounded px-2 py-1">
					<Info className="h-3 w-3 text-blue-500 shrink-0 mt-0.5" />
					<span className="text-[10px] text-foreground/60">Info callout</span>
				</div>
			);
		case "Warning":
			return (
				<div className="flex items-start gap-1.5 bg-yellow-500/10 border border-yellow-500/20 rounded px-2 py-1">
					<AlertTriangle className="h-3 w-3 text-yellow-500 shrink-0 mt-0.5" />
					<span className="text-[10px] text-foreground/60">Warning callout</span>
				</div>
			);
		case "Math":
			return (
				<p className="font-mono text-[13px] text-foreground/70">
					E = mc²
				</p>
			);
		default:
			return (
				<p className="text-[10px] text-muted-foreground">{cmd.description}</p>
			);
	}
}

interface SlashCommandsProps {
	editor: Editor | null;
}

export function SlashCommands({ editor }: SlashCommandsProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [position, setPosition] = useState({ top: 0, left: 0 });
	const [popover, setPopover] = useState<PopoverKind>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const pagePath = useEditorStore((s) => s.currentPath);

	const filtered = commands.filter(
		(cmd) =>
			cmd.label.toLowerCase().includes(query.toLowerCase()) ||
			cmd.description.toLowerCase().includes(query.toLowerCase()),
	);

	const handleClose = useCallback(() => {
		setOpen(false);
		setQuery("");
		setSelectedIndex(0);
	}, []);

	const handleSelect = useCallback(
		(command: SlashCommand) => {
			if (!editor) return;
			const { from } = editor.state.selection;
			const slashStart = from - query.length - 1;
			editor.chain().focus().deleteRange({ from: slashStart, to: from }).run();

			if (command.action.type === "direct") {
				command.action.run(editor);
				handleClose();
			} else {
				setPopover(command.action.kind);
				setOpen(false);
				setQuery("");
			}
		},
		[editor, query, handleClose],
	);

	useEffect(() => {
		if (!editor) return;

		const handleKeyDown = (event: KeyboardEvent) => {
			if (!open) {
				if (event.key === "/") {
					const { from } = editor.state.selection;
					const textBefore = editor.state.doc.textBetween(
						Math.max(0, from - 1),
						from,
					);
					if (
						from === 1 ||
						textBefore === "" ||
						textBefore === "\n" ||
						textBefore === " "
					) {
						const coords = editor.view.coordsAtPos(from);
						const editorRect = editor.view.dom.getBoundingClientRect();
						setPosition({
							top: coords.bottom - editorRect.top + 4,
							left: coords.left - editorRect.left,
						});
						setOpen(true);
						setQuery("");
						setSelectedIndex(0);
					}
				}
				return;
			}

			if (event.key === "Escape") {
				event.preventDefault();
				handleClose();
			} else if (event.key === "ArrowDown") {
				event.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, 0));
			} else if (event.key === "Enter") {
				event.preventDefault();
				if (filtered[selectedIndex]) handleSelect(filtered[selectedIndex]);
			} else if (event.key === "Backspace") {
				if (query.length === 0) handleClose();
				else {
					setQuery((q) => q.slice(0, -1));
					setSelectedIndex(0);
				}
			} else if (event.key === " ") {
				handleClose();
			} else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
				setQuery((q) => q + event.key);
				setSelectedIndex(0);
			}
		};

		window.addEventListener("keydown", handleKeyDown, true);
		return () => window.removeEventListener("keydown", handleKeyDown, true);
	}, [editor, open, query, selectedIndex, filtered, handleClose, handleSelect]);

	useEffect(() => {
		if (!open) return;
		const handleClick = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				handleClose();
			}
		};
		window.addEventListener("mousedown", handleClick);
		return () => window.removeEventListener("mousedown", handleClick);
	}, [open, handleClose]);

	const insertMedia = (
		kind: MediaKind,
		payload: { url: string; alt?: string; mimeType?: string },
	) => {
		if (!editor) return;
		const { url, alt, mimeType } = payload;
		const type = mimeType ?? "";
		const isImage =
			kind === "image" ||
			type.startsWith("image/") ||
			/\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(url);

		if (isImage) {
			editor
				.chain()
				.focus()
				.setImage({ src: url, alt: alt ?? "" })
				.run();
		} else {
			editor
				.chain()
				.focus()
				.insertContent(`<a href="${url}">${alt ?? url}</a>`)
				.run();
		}
		setPopover(null);
	};

	const _insertEmoji = (native: string) => {
		if (!editor) return;
		editor.chain().focus().insertContent(native).run();
		setPopover(null);
	};

	const renderPopover = () => {
		if (!popover || !editor) return null;
		const anchor = position;
		if (popover.type === "media") {
			if (!pagePath) return null;
			return (
				<MediaPopover
					kind={popover.kind}
					pagePath={pagePath}
					anchor={anchor}
					onCancel={() => setPopover(null)}
					onInsert={(payload) => insertMedia(popover.kind, payload)}
				/>
			);
		}
		return null;
	};

	if ((!open || filtered.length === 0) && !popover) return null;

	const byCategory = new Map<string, SlashCommand[]>();
	for (const cmd of filtered) {
		const list = byCategory.get(cmd.category) ?? [];
		list.push(cmd);
		byCategory.set(cmd.category, list);
	}
	const order: { key: string; title: string }[] = [
		{ key: "basic", title: "Basic" },
		{ key: "media", title: "Media" },
		{ key: "advanced", title: "Advanced" },
	];

	const flatCommands: SlashCommand[] = filtered;
	const focusedCmd = flatCommands[selectedIndex] ?? null;

	return (
		<>
			{open && filtered.length > 0 && (
				<div
					ref={menuRef}
					className="absolute z-50 w-[280px] bg-popover border border-border rounded-lg shadow-lg overflow-hidden"
					style={{ top: position.top, left: position.left }}
				>
					{/* Scrollable command list */}
					<div className="max-h-[300px] overflow-y-auto py-1">
						{order.map((group) => {
							const items = byCategory.get(group.key);
							if (!items || items.length === 0) return null;
							return (
								<div key={group.key}>
									<div className="text-[9px] uppercase tracking-wider text-muted-foreground px-3 pt-2 pb-1">
										{group.title}
									</div>
									{items.map((cmd) => {
										const flatIndex = flatCommands.indexOf(cmd);
										const Icon = cmd.icon;
										const isFocused = flatIndex === selectedIndex;
										return (
											<button
												key={cmd.label}
												onMouseDown={(e) => {
													e.preventDefault();
													handleSelect(cmd);
												}}
												onMouseEnter={() => setSelectedIndex(flatIndex)}
												className={cn(
													"flex items-center gap-3 w-full px-3 py-1.5 text-left transition-colors",
													isFocused
														? "bg-accent text-accent-foreground ring-1 ring-inset ring-accent-foreground/10"
														: "hover:bg-accent/50",
												)}
											>
												<Icon
													className={cn(
														"h-4 w-4 shrink-0 transition-colors",
														isFocused
															? "text-accent-foreground"
															: "text-muted-foreground",
													)}
												/>
												<div className="min-w-0">
													<p className="text-[12px] font-medium truncate">
														{cmd.label}
													</p>
													<p
														className={cn(
															"text-[10px] truncate transition-colors",
															isFocused
																? "text-accent-foreground/70"
																: "text-muted-foreground",
														)}
													>
														{cmd.description}
													</p>
												</div>
											</button>
										);
									})}
								</div>
							);
						})}
					</div>

					{/* Preview pane for focused command */}
					{focusedCmd && (
						<div className="border-t border-border bg-muted/30 px-3 py-2 min-h-[52px] flex items-center">
							<CommandPreview cmd={focusedCmd} />
						</div>
					)}
				</div>
			)}
			{renderPopover()}
		</>
	);
}
