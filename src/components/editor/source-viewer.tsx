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
	const [binary, setBinary] = useState(false);
	const [loading, setLoading] = useState(true);
	const [wrap, setWrap] = useState(false);
	const [copied, setCopied] = useState(false);

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

	const highlightedLines = useMemo(() => {
		if (!content) return [];
		try {
			const tree = language
				? lowlight.highlight(language, content)
				: lowlight.highlightAuto(content);
			const html = toHtml(tree);
			// Split by newlines while preserving HTML tags that span lines
			return html.split("\n");
		} catch {
			// Fallback: no highlighting
			return content
				.split("\n")
				.map((line) =>
					line
						.replace(/&/g, "&amp;")
						.replace(/</g, "&lt;")
						.replace(/>/g, "&gt;"),
				);
		}
	}, [content, language]);

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
					<table className="w-full border-collapse text-[13px] leading-relaxed font-mono">
						<tbody>
							{highlightedLines.map((lineHtml, i) => (
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
				)}
			</div>
		</div>
	);
}
