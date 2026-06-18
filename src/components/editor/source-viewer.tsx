"use client";

import { toHtml } from "hast-util-to-html";
import { common, createLowlight } from "lowlight";
import { Check, Copy, Download, ExternalLink, WrapText } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommentPip } from "@/components/editor/comment-pip";
import { CommentThread } from "@/components/editor/comment-thread";
import { ViewModeCommentButton } from "@/components/editor/view-mode-comment-button";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { Button } from "@/components/ui/button";
import { FileFallbackViewer } from "@/components/editor/file-fallback-viewer";
import { useProofStore } from "@/stores/proof-store";
import type { Comment, LineAnchor } from "@/lib/proof/types";
import { withWs, wsFetch } from "@/lib/workspace-client";

// Heuristic binary sniff: a NUL byte never appears in UTF-8/UTF-16LE text we
// care about, and a high ratio of control chars (excluding tab/newline/CR)
// signals binary. Only inspect a prefix — enough to classify cheaply.
function looksBinary(bytes: Uint8Array): boolean {
	const n = Math.min(bytes.length, 8192);
	if (n === 0) return false;
	let suspicious = 0;
	for (let i = 0; i < n; i++) {
		const b = bytes[i];
		if (b === 0) return true; // NUL → definitely binary
		// Allow tab(9), LF(10), CR(13); flag other C0 control chars.
		if (b < 9 || (b > 13 && b < 32)) suspicious++;
	}
	return suspicious / n > 0.3;
}

interface SourceViewerProps {
	path: string;
	title: string;
}

const lowlight = createLowlight(common);

// Large files skip syntax highlighting (lowlight is synchronous and blocks the
// main thread) and render in chunks (one <tr> per line freezes the tab).
const LARGE_BYTES = 2 * 1024 * 1024; // 2 MB
const LARGE_LINES = 5000;
const RENDER_CHUNK = 2000; // lines added per "Show more"

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function splitLines(content: string): string[] {
	return content.replace(/\r\n/g, "\n").split("\n");
}

function lineAnchorKey(anchor: LineAnchor): string {
	return `${anchor.lineStart}:${anchor.lineEnd}:${anchor.textHash}`;
}

function lineAnchorLabel(anchor: LineAnchor): string {
	return `L${anchor.lineStart}-${anchor.lineEnd}`;
}

	async function hashSelectionText(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 12);
}

const EXT_TO_LANG: Record<string, string> = {
	".js": "javascript",
	".cjs": "javascript",
	".mjs": "javascript",
	".ts": "typescript",
	".tsx": "typescript",
	".jsx": "javascript",
	".py": "python",
	".rb": "ruby",
	".php": "php",
	".sh": "bash",
	".bash": "bash",
	".zsh": "bash",
	".ps1": "powershell",
	".css": "css",
	".scss": "scss",
	".html": "xml",
	".json": "json",
	".jsonc": "json",
	".yaml": "yaml",
	".yml": "yaml",
	".toml": "ini",
	".ini": "ini",
	".xml": "xml",
	".sql": "sql",
	".graphql": "graphql",
	".gql": "graphql",
	".go": "go",
	".rs": "rust",
	".swift": "swift",
	".java": "java",
	".kt": "kotlin",
	".kts": "kotlin",
	".c": "c",
	".cpp": "cpp",
	".h": "c",
	".env": "bash",
	".txt": "",
	".text": "",
	".log": "",
	".rst": "",
	".mdx": "markdown",
};

function detectLanguage(filename: string): string {
	const ext = filename.includes(".")
		? `.${filename.split(".").pop()?.toLowerCase()}`
		: "";
	return EXT_TO_LANG[ext] ?? "";
}

function formatBadge(filename: string): string {
	if (!filename.includes(".")) return "TEXT";
	return filename.split(".").pop()?.toUpperCase() ?? "TEXT";
}

type ThreadTarget = {
	anchorKey: string;
	anchorLabel: string;
	lineAnchor: LineAnchor;
	anchorEl: HTMLElement;
};

export function SourceViewer({ path }: SourceViewerProps) {
	const [content, setContent] = useState<string | null>(null);
	const [byteSize, setByteSize] = useState(0);
	const [binary, setBinary] = useState(false);
	const [loading, setLoading] = useState(true);
	const [wrap, setWrap] = useState(false);
	const [copied, setCopied] = useState(false);
	const [visibleCount, setVisibleCount] = useState(RENDER_CHUNK);
	const [linePositions, setLinePositions] = useState<
		Map<number, { top: number; left: number; width: number; bottom: number }>
	>(new Map());
	const [threadTarget, setThreadTarget] = useState<ThreadTarget | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);

	const assetUrl = withWs(`/api/assets/${path}`);
	const filename = path.split("/").pop() || path;
	const language = detectLanguage(filename);
	const sidecar = useProofStore((s) => s.byPath[path]?.sidecar ?? null);
	const comments = sidecar?.comments ?? [];
	const lines = useMemo(() => (content ? splitLines(content) : []), [content]);

	const fetchContent = useCallback(async () => {
		setLoading(true);
		setBinary(false);
		setContent(null);
		setByteSize(0);
		try {
			const res = await wsFetch(assetUrl);
			if (res.ok) {
				const bytes = new Uint8Array(await res.arrayBuffer());
				if (looksBinary(bytes)) {
					setBinary(true);
				} else {
					setByteSize(bytes.length);
					setContent(new TextDecoder("utf-8").decode(bytes));
				}
			}
		} catch {
			/* ignore */
		} finally {
			setLoading(false);
		}
	}, [assetUrl]);

	useEffect(() => {
		void fetchContent();
		void useProofStore.getState().loadSidecar(path);
		setVisibleCount(RENDER_CHUNK);
		setThreadTarget(null);
	}, [fetchContent, path]);

	const lineCount = useMemo(() => lines.length, [lines]);
	const isLarge = byteSize > LARGE_BYTES || lineCount > LARGE_LINES;

	const highlightedLines = useMemo(() => {
		if (!content) return [];
		if (isLarge) return lines.map(escapeHtml);
		try {
			const tree = language
				? lowlight.highlight(language, content)
				: lowlight.highlightAuto(content);
			// Split on newlines, preserving tags that span lines.
			return toHtml(tree).split("\n");
		} catch {
			return lines.map(escapeHtml);
		}
	}, [content, language, isLarge, lines]);

	const shownLines = isLarge ? highlightedLines.slice(0, visibleCount) : highlightedLines;
	const hasMore = isLarge && visibleCount < highlightedLines.length;

	const commentsByAnchor = useMemo(() => {
		const map: Record<string, Comment[]> = {};
		for (const c of comments) {
			if (!c.lineAnchor) continue;
			const key = lineAnchorKey(c.lineAnchor);
			(map[key] ??= []).push(c);
		}
		return map;
	}, [comments]);

	useEffect(() => {
		if (!content || binary || loading || !containerRef.current) {
			setLinePositions(new Map());
			return;
		}
		const container = containerRef.current;
		const containerRect = container.getBoundingClientRect();
		const rows = Array.from(container.querySelectorAll("[data-line]")) as HTMLElement[];
		const next = new Map<number, { top: number; left: number; width: number; bottom: number }>();
		for (const row of rows) {
			const line = Number(row.dataset.line);
			if (!Number.isFinite(line)) continue;
			const rect = row.getBoundingClientRect();
			next.set(line, {
				top: rect.top - containerRect.top + container.scrollTop,
				left: rect.left - containerRect.left,
				width: rect.width,
				bottom: rect.bottom - containerRect.top + container.scrollTop,
			});
		}
		setLinePositions(next);
	}, [content, binary, loading, visibleCount, wrap, highlightedLines]);
	const openSelectionThread = useCallback(() => {
		const container = containerRef.current;
		const sel = window.getSelection();
		if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) return;
		const range = sel.getRangeAt(0);
		if (!container.contains(range.commonAncestorContainer)) return;
		const rowFor = (node: Node | null) => {
			const el = node
				? node.nodeType === Node.ELEMENT_NODE
					? (node as HTMLElement)
					: node.parentElement
				: null;
			return el?.closest<HTMLElement>("[data-line]") ?? null;
		};
		const startRow = rowFor(range.startContainer);
		const endRow = rowFor(range.endContainer);
		if (!startRow || !endRow) return;
		const startLine = Number(startRow.dataset.line);
		const endLine = Number(endRow.dataset.line);
		if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return;
		const lineStart = Math.min(startLine, endLine);
		const lineEnd = Math.max(startLine, endLine);
		const selectedText = lines.slice(lineStart - 1, lineEnd).join("\n");
		void (async () => {
			const anchor: LineAnchor = {
				lineStart,
				lineEnd,
				textHash: await hashSelectionText(selectedText),
			};
			setThreadTarget({
				anchorKey: lineAnchorKey(anchor),
				anchorLabel: lineAnchorLabel(anchor),
				lineAnchor: anchor,
				anchorEl: startRow,
			});
		})();
	}, [lines]);

	const openAnchorThread = useCallback((anchor: LineAnchor, anchorEl: HTMLElement) => {
		setThreadTarget({
			anchorKey: lineAnchorKey(anchor),
			anchorLabel: lineAnchorLabel(anchor),
			lineAnchor: anchor,
			anchorEl,
		});
	}, []);

	const copyToClipboard = () => {
		if (!content) return;
		navigator.clipboard.writeText(content);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	if (binary) {
		return <FileFallbackViewer path={path} title={filename} />;
	}

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			<ViewerToolbar path={path} badge={formatBadge(filename)} sublabel={language || undefined}>
				<Button
					variant="ghost"
					size="sm"
					className={`h-7 gap-1.5 text-xs ${wrap ? "bg-muted" : ""}`}
					onClick={() => setWrap((v) => !v)}
					title={wrap ? "Disable line wrap" : "Enable line wrap"}
				>
					<WrapText className="h-3.5 w-3.5" />
					Wrap
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 text-xs"
					onClick={copyToClipboard}
					title="Copy file contents"
				>
					{copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
					{copied ? "Copied" : "Copy"}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 text-xs"
					onClick={() => {
						const a = document.createElement("a");
						a.href = assetUrl;
						a.download = filename;
						a.click();
					}}
					title="Download file"
				>
					<Download className="h-3.5 w-3.5" />
					Download
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 text-xs"
					onClick={() => window.open(assetUrl, "_blank")}
				>
					<ExternalLink className="h-3.5 w-3.5" />
					Raw
				</Button>
			</ViewerToolbar>
			<div ref={containerRef} className="relative flex-1 overflow-auto source-viewer-code bg-muted">
				{!loading && content && !binary && <ViewModeCommentButton containerRef={containerRef} onComment={openSelectionThread} align="left" />}
				<div className="relative pointer-events-none" style={{ height: 0 }}>
					{Object.entries(commentsByAnchor).map(([anchorKey, anchorComments]) => {
						const anchor = anchorComments[0]?.lineAnchor;
						if (!anchor) return null;
						const pos = linePositions.get(anchor.lineStart);
						if (!pos) return null;
						return (
							<div key={`pip-${anchorKey}`} style={{ pointerEvents: "auto" }}>
								<CommentPip
									anchorKey={anchorKey}
									anchorLabel={lineAnchorLabel(anchor)}
									comments={anchorComments}
									top={pos.top + 4}
									left={Math.max(0, pos.left - 20)}
									onClick={() => {
										const row = containerRef.current?.querySelector(
											`[data-line="${anchor.lineStart}"]`,
										) as HTMLElement | null;
										if (row) openAnchorThread(anchor, row);
									}}
								/>
							</div>
						);
					})}
				</div>
				{loading ? (
					<div className="flex items-center justify-center h-full text-muted-foreground text-sm">Loading...</div>
				) : (
					<>
						{isLarge && (
							<div className="px-4 py-2 text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/15 border-b border-amber-500/30 font-sans">
								Large file ({(byteSize / (1024 * 1024)).toFixed(1)} MB, {highlightedLines.length.toLocaleString()} lines). Syntax highlighting disabled for performance. Use Raw or Download for the full file.
							</div>
						)}
						<div className="text-[13px] leading-relaxed font-mono min-w-max">
							{shownLines.map((lineHtml, i) => {
								const hl = threadTarget?.lineAnchor;
								const active = hl && i + 1 >= hl.lineStart && i + 1 <= hl.lineEnd;
								return (
								<div key={i} data-line={i + 1} className={`flex ${active ? "bg-amber-400/25" : "hover:bg-foreground/5"}`}>
									<span className="w-12 shrink-0 pr-4 text-right text-muted-foreground select-none sticky left-0 bg-muted">{i + 1}</span>
									<span
										className={`text-foreground pl-2 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}
										dangerouslySetInnerHTML={{ __html: lineHtml || " " }}
									/>
								</div>
								);
							})}
						</div>
						{hasMore && (
							<div className="flex items-center gap-3 px-4 py-3 border-t border-border font-sans">
								<button
									onClick={() => setVisibleCount((v) => v + RENDER_CHUNK)}
									className="text-[11px] text-foreground hover:text-foreground px-2.5 py-1 rounded bg-foreground/10 hover:bg-foreground/20 transition-colors"
								>
									Show {Math.min(RENDER_CHUNK, highlightedLines.length - visibleCount).toLocaleString()} more
								</button>
								<span className="text-[11px] text-muted-foreground">
									{visibleCount.toLocaleString()} / {highlightedLines.length.toLocaleString()} lines
								</span>
							</div>
						)}
					</>
				)}
				{threadTarget && (
					<CommentThread
						path={path}
						anchorKey={threadTarget.anchorKey}
						anchorLabel={threadTarget.anchorLabel}
						lineAnchor={threadTarget.lineAnchor}
						comments={commentsByAnchor[threadTarget.anchorKey] ?? []}
						anchorEl={threadTarget.anchorEl}
						onClose={() => setThreadTarget(null)}
					/>
				)}
			</div>
		</div>
	);
}
