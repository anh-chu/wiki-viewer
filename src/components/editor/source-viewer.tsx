"use client";

import { toHtml } from "hast-util-to-html";
import { common, createLowlight } from "lowlight";
import { Check, Copy, Download, ExternalLink, WrapText } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { Button } from "@/components/ui/button";
import { withWs, wsFetch } from "@/lib/workspace-client";
import { FileFallbackViewer } from "@/components/editor/file-fallback-viewer";

// Heuristic binary sniff: a NUL byte never appears in UTF-8/UTF-16LE text we
// care about, and a high ratio of control chars (excluding tab/newline/CR)
// signals binary. Only inspect a prefix \u2014 enough to classify cheaply.
function looksBinary(bytes: Uint8Array): boolean {
	const n = Math.min(bytes.length, 8192);
	if (n === 0) return false;
	let suspicious = 0;
	for (let i = 0; i < n; i++) {
		const b = bytes[i];
		if (b === 0) return true; // NUL \u2192 definitely binary
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

export function SourceViewer({ path }: SourceViewerProps) {
	const [content, setContent] = useState<string | null>(null);
	const [byteSize, setByteSize] = useState(0);
	const [binary, setBinary] = useState(false);
	const [loading, setLoading] = useState(true);
	const [wrap, setWrap] = useState(false);
	const [copied, setCopied] = useState(false);
	const [visibleCount, setVisibleCount] = useState(RENDER_CHUNK);

	const assetUrl = withWs(`/api/assets/${path}`);
	const filename = path.split("/").pop() || path;
	const language = detectLanguage(filename);

	const fetchContent = useCallback(async () => {
		setLoading(true);
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
	}, [fetchContent]);

	const lineCount = useMemo(
		() => (content ? content.split("\n").length : 0),
		[content],
	);

	const isLarge = byteSize > LARGE_BYTES || lineCount > LARGE_LINES;

	const highlightedLines = useMemo(() => {
		if (!content) return [];
		if (isLarge) return content.split("\n").map(escapeHtml);
		try {
			const tree = language
				? lowlight.highlight(language, content)
				: lowlight.highlightAuto(content);
			// Split on newlines, preserving tags that span lines.
			return toHtml(tree).split("\n");
		} catch {
			return content.split("\n").map(escapeHtml);
		}
	}, [content, language, isLarge]);

	const shownLines = isLarge
		? highlightedLines.slice(0, visibleCount)
		: highlightedLines;
	const hasMore = isLarge && visibleCount < highlightedLines.length;

	const copyToClipboard = () => {
		if (!content) return;
		navigator.clipboard.writeText(content);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	// Detected binary at runtime \u2192 reuse the download/reveal fallback UI.
	if (binary) {
		return <FileFallbackViewer path={path} title={filename} />;
	}

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			<ViewerToolbar
				path={path}
				badge={formatBadge(filename)}
				sublabel={language || undefined}
			>
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
					{copied ? (
						<Check className="h-3.5 w-3.5 text-green-500" />
					) : (
						<Copy className="h-3.5 w-3.5" />
					)}
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
			<div className="flex-1 overflow-auto source-viewer-code bg-[#1e1e1e]">
				{loading ? (
					<div className="flex items-center justify-center h-full text-muted-foreground text-sm">
						Loading...
					</div>
				) : (
					<>
					{isLarge && (
						<div className="px-4 py-2 text-[11px] text-amber-200/90 bg-amber-900/30 border-b border-amber-700/40 font-sans">
							Large file ({(byteSize / (1024 * 1024)).toFixed(1)} MB,{" "}
							{highlightedLines.length.toLocaleString()} lines). Syntax
							highlighting disabled for performance. Use Raw or Download for
							the full file.
						</div>
					)}
					<table className="w-full border-collapse text-[13px] leading-relaxed font-mono">
						<tbody>
							{shownLines.map((lineHtml, i) => (
								<tr key={i} className="hover:bg-white/5">
									<td className="w-12 pr-4 text-right text-[#858585] select-none align-top sticky left-0 bg-[#1e1e1e]">
										{i + 1}
									</td>
									<td
										className={`text-[#d4d4d4] pl-2 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}
										dangerouslySetInnerHTML={{ __html: lineHtml || " " }}
									/>
								</tr>
							))}
						</tbody>
					</table>
					{hasMore && (
						<div className="flex items-center gap-3 px-4 py-3 border-t border-white/10 font-sans">
							<button
								onClick={() => setVisibleCount((v) => v + RENDER_CHUNK)}
								className="text-[11px] text-[#d4d4d4] hover:text-white px-2.5 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors"
							>
								Show{" "}
								{Math.min(
									RENDER_CHUNK,
								highlightedLines.length - visibleCount,
							).toLocaleString()}{" "}
								more
							</button>
							<span className="text-[11px] text-[#858585]">
								{visibleCount.toLocaleString()} /{" "}
								{highlightedLines.length.toLocaleString()} lines
							</span>
						</div>
					)}
					</>
				)}
			</div>
		</div>
	);
}
