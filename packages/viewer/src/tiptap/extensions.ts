import Link from "@tiptap/extension-link";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import TextAlign from "@tiptap/extension-text-align";
import StarterKit from "@tiptap/starter-kit";
import { lowlight } from "../lowlight";
import { CalloutExtension } from "./callout-extension";
import { HeadingAnchors } from "./heading-anchors";
import { MermaidCodeBlock } from "./mermaid-code-block";
import { ProofSpan } from "./proof-span";
import { ResizableImage } from "./resizable-image";
import {
	type WikiSlugResolver,
	createWikiLink,
} from "./wiki-link-extension";

// Curated language set: covers ~95% of real-world snippets. The full `common`

export interface ViewerExtensionsOptions {
	wikiSlugResolver?: WikiSlugResolver;
}

/**
 * Create the extension array for the read-only viewer.
 *
 * Placeholder is intentionally omitted — its "Start writing…" prompt
 * must never appear in a read-only viewer, and there is no benefit
 * to keeping it. DragHandle is omitted because it is editing-only chrome
 * that attaches global DOM elements to document.body.
 */
export function createViewerExtensions(
	opts?: ViewerExtensionsOptions,
) {
	return [
		StarterKit.configure({
			heading: { levels: [1, 2, 3, 4] },
			codeBlock: false, // replaced by CodeBlockLowlight
			link: false,
			underline: false,
		}),
		MermaidCodeBlock(lowlight),
		ResizableImage.configure({
			HTMLAttributes: {
				class: "rounded-lg max-w-full",
			},
			allowBase64: false,
		}),
		Table.configure({
			resizable: true,
			lastColumnResizable: false,
			HTMLAttributes: {
				class: "border-collapse w-full",
			},
		}),
		TableRow,
		TableCell,
		TableHeader,
		TaskList.configure({
			HTMLAttributes: {
				class: "task-list",
			},
		}),
		TaskItem.configure({
			nested: true,
		}),
		Link.configure({
			openOnClick: false,
			HTMLAttributes: {
				class: "text-primary underline cursor-pointer",
			},
		}).extend({
			parseHTML() {
				return [
					{
						tag: 'a[href]:not([data-wiki-link="true"])',
					},
				];
			},
			addKeyboardShortcuts() {
				return {
					"Mod-e": () => {
						const { state } = this.editor;
						const { from, to } = state.selection;
						if (from === to) return false;
						const prevUrl = this.editor.getAttributes("link").href ?? "";
						const url =
							typeof window !== "undefined"
								? window.prompt("Link URL", prevUrl)
								: null;
						if (url === null) return false;
						if (url === "") {
							return this.editor
								.chain()
								.focus()
								.extendMarkRange("link")
								.unsetLink()
								.run();
						}
						return this.editor
							.chain()
							.focus()
							.extendMarkRange("link")
							.setLink({ href: url })
							.run();
					},
				};
			},
		}),
		CalloutExtension,
		ProofSpan,
		TextAlign.configure({ types: ["heading", "paragraph"] }),
		Subscript,
		Superscript,
		HeadingAnchors,
		createWikiLink(opts?.wikiSlugResolver),
	];
}
