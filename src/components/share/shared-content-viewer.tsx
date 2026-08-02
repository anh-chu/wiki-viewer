"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, FileText, Play, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiUrl } from "@/lib/url-prefix";
import { markdownToHtml } from "@/lib/markdown/to-html";

type SharedFileKind =
	| "markdown"
	| "source"
	| "text"
	| "csv"
	| "html"
	| "image"
	| "pdf"
	| "media"
	| "binary";

function fileExt(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

export function sharedFileKind(filename: string): SharedFileKind {
	const e = fileExt(filename);
	if (["md", "markdown"].includes(e)) return "markdown";
	if (["csv", "tsv"].includes(e)) return "csv";
	if (["pdf"].includes(e)) return "pdf";
	if (["html", "htm"].includes(e)) return "html";
	if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico", "bmp"].includes(e))
		return "image";
	if (["mp4", "webm", "mov", "m4v", "mp3", "wav", "ogg", "m4a", "aac"].includes(e))
		return "media";
	if (["txt", "log", "ini", "env", "conf"].includes(e)) return "text";
	if (
		[
			"py", "js", "ts", "tsx", "jsx", "go", "rs", "java", "c", "cpp", "h",
			"sh", "bash", "zsh", "rb", "php", "swift", "kt", "lua", "sql", "yaml",
			"yml", "toml", "json", "xml", "css", "scss", "mmd", "mermaid",
		].includes(e)
	)
		return "source";
	return "binary";
}

interface SharedContentViewerProps {
	content: string;
	filename: string;
	filePath: string;
	token: string;
}

export function SharedContentViewer({
	content,
	filename,
	filePath,
	token,
}: SharedContentViewerProps) {
	const kind = sharedFileKind(filename);

	switch (kind) {
		case "markdown":
			return <SharedMarkdownViewer content={content} />;
		case "image":
			return <SharedImageViewer filename={filename} token={token} />;
		case "pdf":
			return <SharedPdfViewer filename={filename} token={token} />;
		case "media":
			return <SharedMediaViewer filename={filename} token={token} />;
		case "html":
			return <SharedHtmlViewer content={content} filename={filename} />;
		case "csv":
			return <SharedCsvViewer content={content} />;
		case "source":
		case "text":
			return <SharedSourceViewer content={content} filename={filename} />;
		case "binary":
			return <SharedBinaryViewer filename={filename} token={token} />;
	}
}

function SharedMarkdownViewer({ content }: { content: string }) {
	const [html, setHtml] = useState<string>("");

	useEffect(() => {
		let cancelled = false;
		void markdownToHtml(content, { sanitize: true }).then((h) => {
			if (!cancelled) setHtml(h);
		});
		return () => {
			cancelled = true;
		};
	}, [content]);

	return (
		<div className="flex-1 overflow-auto">
			<div className="mx-auto max-w-4xl px-4 py-8 prose prose-neutral dark:prose-invert">
				<div dangerouslySetInnerHTML={{ __html: html }} />
			</div>
		</div>
	);
}

function SharedImageViewer({ filename, token }: { filename: string; token: string }) {
	const assetUrl = apiUrl(`/api/share/${token}/asset`);
	return (
		<div className="flex-1 flex items-center justify-center p-8 bg-[repeating-conic-gradient(hsl(var(--muted))_0%_25%,transparent_0%_50%)] bg-[length:20px_20px]">
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img
				src={assetUrl}
				alt={filename}
				className="max-w-full max-h-[80vh] object-contain rounded-sm"
			/>
		</div>
	);
}

function SharedPdfViewer({ filename, token }: { filename: string; token: string }) {
	const assetUrl = apiUrl(`/api/share/${token}/asset`);
	return (
		<div className="flex-1 flex flex-col min-h-0">
			<iframe
				src={assetUrl}
				title={filename}
				className="flex-1 w-full border-0"
				style={{ minHeight: "80vh" }}
			/>
		</div>
	);
}

function SharedMediaViewer({ filename, token }: { filename: string; token: string }) {
	const assetUrl = apiUrl(`/api/share/${token}/asset`);
	const e = fileExt(filename);
	const isVideo = ["mp4", "webm", "mov", "m4v"].includes(e);
	return (
		<div className="flex-1 flex items-center justify-center p-8">
			{isVideo ? (
				<video controls className="max-w-full max-h-[80vh] rounded-sm" src={assetUrl} />
			) : (
				<div className="w-full max-w-md">
					<audio controls className="w-full" src={assetUrl} />
					<p className="text-center text-sm text-muted-foreground mt-3">{filename}</p>
				</div>
			)}
		</div>
	);
}

function SharedHtmlViewer({ content, filename }: { content: string; filename: string }) {
	const [scriptsEnabled, setScriptsEnabled] = useState(false);

	const sandbox = scriptsEnabled
		? "allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation"
		: "allow-forms allow-popups allow-top-navigation-by-user-activation";

	return (
		<div className="flex-1 flex flex-col min-h-0">
			<div className="flex items-center justify-end gap-2 px-4 py-2 border-b bg-muted/30">
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 text-xs"
					onClick={() => setScriptsEnabled((s) => !s)}
				>
					{scriptsEnabled ? (
						<>
							<Ban className="h-3.5 w-3.5" />
							Disable scripts
						</>
					) : (
						<>
							<Play className="h-3.5 w-3.5" />
							Enable scripts
						</>
					)}
				</Button>
			</div>
			<iframe
				srcDoc={content}
				title={filename}
				className="flex-1 w-full border-0 bg-white"
				style={{ minHeight: "80vh" }}
				sandbox={sandbox}
			/>
		</div>
	);
}

function SharedSourceViewer({ content, filename }: { content: string; filename: string }) {
	const lines = content.split("\n");
	const lineCount = lines.length;
	const [showAll, setShowAll] = useState(lineCount <= 500);
	const visibleLines = showAll ? lines : lines.slice(0, 500);

	return (
		<div className="flex-1 overflow-auto">
			<div className="mx-auto max-w-4xl">
				<div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
					<span className="text-xs text-muted-foreground font-mono">{filename}</span>
					<span className="text-xs text-muted-foreground">
						{lineCount.toLocaleString()} lines
					</span>
				</div>
				<pre className="text-[13px] font-mono leading-relaxed">
					<table className="w-full border-collapse">
						<tbody>
							{visibleLines.map((line, i) => (
								<tr key={i} className="hover:bg-muted/50">
									<td className="select-none text-right pr-4 pl-4 py-0 text-muted-foreground/50 text-xs w-[1%] whitespace-nowrap align-top">
										{i + 1}
									</td>
									<td className="pr-4 py-0 whitespace-pre-wrap break-all">
										{line || "\u00a0"}
									</td>
									</tr>
							))}
						</tbody>
					</table>
				</pre>
				{!showAll && lineCount > 500 && (
					<div className="flex justify-center py-4 border-t">
						<Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
							Show all {lineCount.toLocaleString()} lines
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}

function SharedCsvViewer({ content }: { content: string }) {
	const rows = useMemo(() => {
		return content
			.split("\n")
			.filter(Boolean)
			.map((row) => {
				const cells: string[] = [];
				let current = "";
				let inQuotes = false;
				for (let i = 0; i < row.length; i++) {
					const ch = row[i];
					if (ch === '"') {
						inQuotes = !inQuotes;
					} else if ((ch === "," || ch === "\t") && !inQuotes) {
						cells.push(current.trim());
						current = "";
					} else {
						current += ch;
					}
				}
				cells.push(current.trim());
				return cells;
			});
	}, [content]);

	if (rows.length === 0) return null;
	const header = rows[0];
	const body = rows.slice(1);

	return (
		<div className="flex-1 overflow-auto">
			<div className="mx-auto max-w-6xl p-4">
				<table className="w-full text-sm border-collapse">
					<thead>
						<tr>
							{header.map((cell, i) => (
								<th
									key={i}
									className="text-left px-3 py-2 border-b-2 border-border font-medium bg-muted/50 whitespace-nowrap"
								>
									{cell}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{body.map((row, i) => (
							<tr key={i} className="hover:bg-muted/30">
								{row.map((cell, j) => (
									<td
										key={j}
										className="px-3 py-1.5 border-b border-border/50 whitespace-nowrap"
									>
										{cell}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function SharedBinaryViewer({ filename, token }: { filename: string; token: string }) {
	const assetUrl = apiUrl(`/api/share/${token}/asset`);
	return (
		<div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
			<FileText className="h-12 w-12 text-muted-foreground" />
			<p className="text-sm text-muted-foreground">{filename}</p>
			<a href={assetUrl} download={filename}>
				<Button size="sm" variant="outline" className="gap-1.5">
					<Download className="h-3.5 w-3.5" />
					Download file
				</Button>
			</a>
		</div>
	);
}
