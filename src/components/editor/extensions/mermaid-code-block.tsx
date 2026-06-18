"use client";

import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import {
	type NodeViewProps,
	NodeViewContent,
	NodeViewWrapper,
	ReactNodeViewRenderer,
} from "@tiptap/react";
import type { createLowlight } from "lowlight";
import { useEffect, useRef, useState } from "react";
import { MermaidCanvas } from "../mermaid-canvas";

const CODE_CLASS = "rounded-md bg-muted p-4 font-mono text-sm";

let renderSeq = 0;

function MermaidCodeBlockView(props: NodeViewProps) {
	const { node, editor } = props;
	const language = (node.attrs.language as string | null) ?? "";
	const isMermaid = language === "mermaid";

	const source = node.textContent;
	const [svg, setSvg] = useState("");
	const [error, setError] = useState("");
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!isMermaid) return;
		const code = source.trim();
		if (!code) {
			setSvg("");
			setError("");
			return;
		}
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(async () => {
			try {
				const mermaid = (await import("mermaid")).default;
				mermaid.initialize({
					startOnLoad: false,
					theme: document.documentElement.classList.contains("dark")
						? "dark"
						: "default",
					securityLevel: "loose",
					suppressErrorRendering: true,
				});
				await mermaid.parse(code);
				const { svg: rendered } = await mermaid.render(
					`mermaid-cb-${++renderSeq}`,
					code,
				);
				setSvg(rendered);
				setError("");
			} catch (err) {
				// Clean up any error nodes mermaid injects into <body>
				document
					.querySelectorAll('[id^="dmermaid-cb-"]')
					.forEach((el) => el.remove());
				setError(err instanceof Error ? err.message : "Failed to render");
			}
		}, 300);
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [isMermaid, source]);

	// Non-mermaid: plain code block, lowlight decorations apply to NodeViewContent.
	if (!isMermaid) {
		return (
			<NodeViewWrapper as="pre" className={CODE_CLASS}>
				<NodeViewContent<"code"> as="code" />
			</NodeViewWrapper>
		);
	}

	const editing = editor.isEditable;
	const showDiagram = svg && (!editing || !error);

	return (
		<NodeViewWrapper className="my-3">
			{/* Source: editable in edit mode; hidden in view mode when diagram renders */}
			<pre
				className={CODE_CLASS}
				style={{
					display: !editing && showDiagram ? "none" : undefined,
				}}
			>
				<NodeViewContent<"code"> as="code" />
			</pre>
			{showDiagram && (
				<div
					className="mermaid-preview rounded-md border border-border bg-card"
					contentEditable={false}
				>
					<MermaidCanvas svg={svg} className="h-[400px] w-full" />
				</div>
			)}
			{editing && error && (
				<div
					className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-500"
					contentEditable={false}
				>
					Mermaid error: {error}
				</div>
			)}
		</NodeViewWrapper>
	);
}

export const MermaidCodeBlock = (lowlight: ReturnType<typeof createLowlight>) =>
	CodeBlockLowlight.configure({
		lowlight,
		HTMLAttributes: { class: CODE_CLASS },
	}).extend({
		addNodeView() {
			return ReactNodeViewRenderer(MermaidCodeBlockView);
		},
	});
