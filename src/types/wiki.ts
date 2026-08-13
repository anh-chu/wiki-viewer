// Canonical wiki tree and viewer types shared between the page shell, the
// editor, and tree-related helpers. These match the /api/wiki entry shape and
// the OpenFile contract used by the viewer pane.

export type FileTreeNodeType = "dir" | "file" | "app" | "node-app";

export interface FileTreeNode {
	name: string;
	path: string;
	type: FileTreeNodeType;
	size?: number;
	modifiedAt: string;
	children?: FileTreeNode[];
	expanded?: boolean;
	loading?: boolean;
	git?: { branch: string; dirty: boolean };
}

export interface OpenFile {
	path: string;
	name: string;
	nodeType: "file" | "app" | "node-app";
	size?: number;
	/** When set, the website viewer renders this external URL instead of a file. */
	externalUrl?: string;
}

export type ViewerKind =
	| "editor"
	| "csv"
	| "pdf"
	| "mermaid"
	| "notebook"
	| "image"
	| "media"
	| "docx"
	| "xlsx"
	| "pptx"
	| "source"
	| "fallback"
	| "app"
	| "html"
	| "node-app"
	| "text";
