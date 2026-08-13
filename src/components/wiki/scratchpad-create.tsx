"use client";

import { FileText, Globe, Upload, X } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ScratchpadCreateProps {
	onText: (text: string) => void;
	onFile: (file: File) => void;
	onUrl: (url: string) => void;
	onCancel: () => void;
}

export function ScratchpadCreate({
	onText,
	onFile,
	onUrl,
	onCancel,
}: ScratchpadCreateProps) {
	const [text, setText] = useState("");
	const [url, setUrl] = useState("");
	const [dragOver, setDragOver] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	return (
		<div
			className="flex-1 flex flex-col overflow-auto"
			onDragOver={(e) => {
				e.preventDefault();
				setDragOver(true);
			}}
			onDragLeave={() => setDragOver(false)}
			onDrop={(e) => {
				e.preventDefault();
				setDragOver(false);
				const f = e.dataTransfer.files?.[0];
				if (f) onFile(f);
			}}
		>
			<div className="flex items-center justify-between px-4 py-2 border-b bg-muted shrink-0">
				<span className="text-sm font-medium">Scratchpad</span>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 w-7 p-0"
					onClick={onCancel}
				>
					<X className="h-3.5 w-3.5" />
				</Button>
			</div>

			<div
				className={cn(
					"flex-1 flex flex-col gap-4 p-4 max-w-2xl w-full mx-auto",
					dragOver && "outline-2 outline-dashed outline-primary rounded-md",
				)}
			>
				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<FileText className="h-3.5 w-3.5" />
						Paste or type anything (markdown, HTML, code)
					</div>
					<textarea
						autoFocus
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder="Paste or type here, then press Open (or Cmd/Ctrl+Enter)…"
						spellCheck={false}
						className="min-h-[180px] w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-[13px] leading-relaxed outline-none"
						onKeyDown={(e) => {
							if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
								e.preventDefault();
								onText(text);
							}
						}}
					/>
					<div className="flex justify-end">
						<Button size="sm" onClick={() => onText(text)} disabled={!text.trim()}>
							Open
						</Button>
					</div>
				</div>

				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<Globe className="h-3.5 w-3.5" />
						Open a web link
					</div>
					<div className="flex gap-2">
						<input
							type="text"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							placeholder="https://example.com"
							className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm outline-none"
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									onUrl(url);
								}
							}}
						/>
						<Button size="sm" variant="secondary" onClick={() => onUrl(url)} disabled={!url.trim()}>
							Open
						</Button>
					</div>
				</div>

				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<Upload className="h-3.5 w-3.5" />
						Drop a file anywhere here, or
					</div>
					<div>
						<Button
							size="sm"
							variant="outline"
							onClick={() => fileInputRef.current?.click()}
						>
							Choose file…
						</Button>
						<input
							ref={fileInputRef}
							type="file"
							className="hidden"
							onChange={(e) => {
								const f = e.target.files?.[0];
								if (f) onFile(f);
							}}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}
