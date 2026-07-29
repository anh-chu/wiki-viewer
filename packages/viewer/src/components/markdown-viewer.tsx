"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useMemo } from "react";
import { parseFrontmatter } from "../markdown/parse-frontmatter";
import { renderMarkdownToHtml } from "../markdown/to-html";
import { createViewerExtensions } from "../tiptap/extensions";
import { DocumentOutline } from "./document-outline";
import { FrontmatterHeader } from "./frontmatter-header";

export interface MarkdownViewerProps {
	content: string;
	filename: string;
	assetUrlTransform?: (url: string) => string;
	/** CSS max-width for the content column. Default "64rem" (app's "normal" width). */
	maxWidth?: string;
	/** CSS margin-left for the content column. Default "auto" (centered). */
	marginLeft?: string;
}

const EDITOR_CLASS =
	"focus:outline-none min-h-[calc(100vh-12rem)] px-4 sm:px-8 py-6 max-w-[var(--editor-max-w,48rem)] ml-[var(--editor-ml,auto)] mr-auto";

export function MarkdownViewer({
	content,
	filename,
	assetUrlTransform,
	maxWidth = "64rem",
	marginLeft = "auto",
}: MarkdownViewerProps) {
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);

	const extensions = useMemo(
		() => createViewerExtensions(),
		// Stable across renders; resolver is omitted (all slugs unknown).
		[],
	);

	const editor = useEditor({
		extensions,
		content: "",
		editable: false,
		editorProps: {
			attributes: {
				class: EDITOR_CLASS,
			},
			handleClick: (_view, _pos, event) => {
				const target = event.target as HTMLElement;
				const link = target.closest("a") as HTMLAnchorElement | null;
				if (!link) return false;

				// Wiki-links: inert in the viewer (no page navigation available).
				if (link.dataset.wikiLink === "true") {
					event.preventDefault();
					event.stopPropagation();
					return true;
				}

				// External links: let the browser handle them normally.
				return false;
			},
		},
		immediatelyRender: false,
	});

	// Parse frontmatter once per content change.
	const parsed = useMemo(() => parseFrontmatter(content), [content]);

	// Render markdown body → HTML and load into editor whenever content changes.
	// Using a ref + key approach: track the last rendered content to avoid
	// re-setting on unrelated editor updates, but allow later documents to
	// replace earlier ones (no one-shot guard).
	const lastRenderedRef = useRef<string>("");

	useEffect(() => {
		if (!editor || content === lastRenderedRef.current) return;

		let cancelled = false;
		const body = parsed.body || content;

		renderMarkdownToHtml(body, {
			docPath: filename || undefined,
			assetUrlTransform,
		}).then((html) => {
			if (cancelled) return;
			lastRenderedRef.current = content;
			editor.commands.setContent(html);
		});

		return () => {
			cancelled = true;
		};
	}, [editor, content, parsed.body, filename, assetUrlTransform]);

	// Reset scroll position when content changes (new document).
	const prevContentRef = useRef(content);
	useEffect(() => {
		if (prevContentRef.current !== content) {
			prevContentRef.current = content;
			scrollContainerRef.current?.scrollTo(0, 0);
		}
	}, [content]);

	const hasFrontmatter = Object.keys(parsed.data).length > 0;

	return (
		<div className="wv-viewer-root flex-1 relative">
			<DocumentOutline editor={editor} scrollContainerRef={scrollContainerRef} />

			<div
				ref={scrollContainerRef}
				className="absolute inset-0 overflow-y-auto"
				style={{
					["--editor-max-w" as string]: maxWidth,
					["--editor-ml" as string]: marginLeft,
				}}
				data-editor-scroll
			>
				{hasFrontmatter && (
					<div className="max-w-[var(--editor-max-w,48rem)] ml-[var(--editor-ml,auto)] mr-auto px-4 sm:px-8 pt-6">
						<FrontmatterHeader
							data={parsed.data as Record<string, never>}
						/>
					</div>
				)}

				<EditorContent editor={editor} />
			</div>
		</div>
	);
}
