// Editor types used by the editor, stores, and viewer components.

export interface FrontMatter {
	title: string;
	created: string;
	modified: string;
	tags: string[];
	icon?: string;
	order?: number;
	dir?: "ltr" | "rtl";
}

export type SaveStatus = "idle" | "saving" | "saved" | "error";
