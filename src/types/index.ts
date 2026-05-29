// Editor types used by the editor, stores, and viewer components.

export interface GoogleFrontmatter {
	kind?: "sheets" | "slides" | "docs" | "forms" | "drive";
	url: string;
	embedUrl?: string;
}

export interface FrontMatter {
	title: string;
	created: string;
	modified: string;
	tags: string[];
	icon?: string;
	order?: number;
	dir?: "ltr" | "rtl";
	google?: GoogleFrontmatter;
}

export interface TreeNode {
	name: string;
	path: string;
	type:
		| "file"
		| "directory"
		| "cabinet"
		| "website"
		| "app"
		| "pdf"
		| "csv"
		| "code"
		| "image"
		| "video"
		| "audio"
		| "mermaid"
		| "docx"
		| "xlsx"
		| "pptx"
		| "notebook"
		| "unknown";
	hasRepo?: boolean;
	isLinked?: boolean;
	frontmatter?: Partial<FrontMatter>;
	children?: TreeNode[];
}

export type SaveStatus = "idle" | "saving" | "saved" | "error";
