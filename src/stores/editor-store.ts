import { create } from "zustand";
import type { FrontMatter, SaveStatus } from "@/types";

// Adapter around ccmc's /api/wiki/content endpoints.
// The API returns { content: string } and accepts { path, content }.
// We model frontmatter as null since ccmc doesn't expose it from the API.

export class FetchPageError extends Error {
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = "FetchPageError";
	}
}

interface PageData {
	path: string;
	content: string;
	frontmatter: FrontMatter | null;
	revision: number | null;
}

async function fetchPageFromApi(path: string): Promise<PageData> {
	const res = await fetch(`/api/wiki/content?path=${encodeURIComponent(path)}`);
	if (!res.ok) {
		throw new FetchPageError(`Failed to fetch page: ${path}`, res.status);
	}
	const data: { content: string } = await res.json();
	const revHeader = res.headers.get("X-Wiki-Revision");
	const revision = revHeader !== null ? Number(revHeader) : null;
	return { path, content: data.content, frontmatter: null, revision };
}

interface SaveResult {
	revision: number | null;
}

/** Error thrown when the server reports a stale revision (409). */
export class StaleRevisionError extends Error {
	constructor(
		public readonly currentRevision: number,
		public readonly serverContent: string,
	) {
		super("File was modified externally. Reloaded with latest content.");
		this.name = "StaleRevisionError";
	}
}

async function savePageToApi(
	path: string,
	content: string,
	baseRevision: number | null,
): Promise<SaveResult> {
	const body: Record<string, unknown> = { path, content };
	if (baseRevision !== null) body.baseRevision = baseRevision;
	const res = await fetch("/api/wiki/content", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (res.status === 409) {
		// Server has a newer revision. Fetch current content and surface the conflict.
		const conflictData = (await res.json()) as { currentRevision?: number };
		const freshRes = await fetch(`/api/wiki/content?path=${encodeURIComponent(path)}`);
		const freshContent = freshRes.ok
			? ((await freshRes.json()) as { content: string }).content
			: content;
		throw new StaleRevisionError(conflictData.currentRevision ?? 0, freshContent);
	}
	if (!res.ok) {
		throw new Error("Failed to save page");
	}
	const data = (await res.json()) as { revision?: number };
	return { revision: data.revision ?? null };
}

async function createPageInApi(path: string, content = ""): Promise<void> {
	// ccmc has no dedicated create endpoint; saving empty content creates the file.
	await savePageToApi(path, content, null);
}

const PAGE_CACHE_KEY = "kb-page-cache";

interface CachedPage {
	path: string;
	content: string;
	frontmatter: FrontMatter | null;
}

function loadCachedPage(path: string): CachedPage | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = localStorage.getItem(PAGE_CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as CachedPage;
		if (parsed.path !== path) return null;
		return parsed;
	} catch {
		return null;
	}
}

function saveCachedPage(page: CachedPage) {
	if (typeof window === "undefined") return;
	try {
		localStorage.setItem(PAGE_CACHE_KEY, JSON.stringify(page));
	} catch {
		// quota errors are non-fatal
	}
}

export type LoadStatus = "idle" | "loading" | "ok" | "missing" | "error";

interface EditorState {
	currentPath: string | null;
	content: string;
	frontmatter: FrontMatter | null;
	saveStatus: SaveStatus;
	loadStatus: LoadStatus;
	isDirty: boolean;
	isLoading: boolean;
	lastSavedAt: number | null;
	/** Last confirmed revision from the server. null until first save/sync. */
	currentRevision: number | null;

	loadPage: (path: string) => Promise<void>;
	updateContent: (content: string) => void;
	updateFrontmatter: (updates: Partial<FrontMatter>) => void;
	save: () => Promise<void>;
	createMissingPage: (title: string) => Promise<void>;
	clear: () => void;
	/** Sync the known revision from an external source (e.g. proof-store snapshot). */
	syncRevision: (revision: number) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

export const useEditorStore = create<EditorState>((set, get) => ({
	currentPath: null,
	content: "",
	frontmatter: null,
	saveStatus: "idle",
	loadStatus: "idle",
	isDirty: false,
	isLoading: false,
	lastSavedAt: null,
	currentRevision: null,

	loadPage: async (path: string) => {
		const currentState = get();
		// If we're switching to a different page, save any pending changes first.
		if (
			currentState.isDirty &&
			currentState.currentPath &&
			currentState.currentPath !== path
		) {
			await get().save();
		}

		set({
			currentPath: path,
			isLoading: true,
			loadStatus: "loading",
			isDirty: false,
			content: "",
			currentRevision: null,
		});

		// Paint from cache immediately so the editor feels instant.
		const cached = loadCachedPage(path);
		if (cached) {
			set({
				content: cached.content,
				frontmatter: cached.frontmatter,
				isLoading: false,
				loadStatus: "ok",
			});
		}

		try {
			const page = await fetchPageFromApi(path);
			// A newer loadPage() call may have superseded us.
			if (get().currentPath !== path) return;
			set({
				content: page.content,
				frontmatter: page.frontmatter,
				isLoading: false,
				loadStatus: "ok",
				currentRevision: page.revision,
			});
			saveCachedPage({
				path,
				content: page.content,
				frontmatter: page.frontmatter,
			});
		} catch (err) {
			if (get().currentPath !== path) return;
			if (err instanceof FetchPageError && err.status === 404) {
				set({ isLoading: false, loadStatus: "missing", content: "" });
			} else {
				// Keep cached content visible; mark as error.
				set({ isLoading: false, loadStatus: "error" });
			}
		}
	},

	updateContent: (content: string) => {
		set({ content, isDirty: true });

		// Auto-save after 500 ms of inactivity.
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			get().save();
		}, 500);
	},

	updateFrontmatter: (updates: Partial<FrontMatter>) => {
		const current = get().frontmatter;
		set({
			frontmatter: { ...current, ...updates } as FrontMatter,
			isDirty: true,
		});
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			get().save();
		}, 500);
	},

	save: async () => {
		const { currentPath, content, isDirty, currentRevision } = get();
		if (!currentPath || !isDirty) return;

		set({ saveStatus: "saving" });
		try {
			const result = await savePageToApi(currentPath, content, currentRevision);
			set({
				saveStatus: "saved",
				isDirty: false,
				lastSavedAt: Date.now(),
				currentRevision: result.revision ?? currentRevision,
			});
			saveCachedPage({
				path: currentPath,
				content,
				frontmatter: get().frontmatter,
			});

			if (statusTimer) clearTimeout(statusTimer);
			statusTimer = setTimeout(() => {
				if (get().saveStatus === "saved") set({ saveStatus: "idle" });
			}, 2000);
		} catch (err) {
			if (err instanceof StaleRevisionError) {
				// Server has a newer revision: reload editor with fresh content.
				set({
					content: err.serverContent,
					isDirty: false,
					saveStatus: "error",
					currentRevision: err.currentRevision,
				});
				saveCachedPage({
					path: currentPath,
					content: err.serverContent,
					frontmatter: get().frontmatter,
				});
			} else {
				set({ saveStatus: "error" });
			}
		}
	},

	createMissingPage: async (title: string) => {
		const { currentPath } = get();
		if (!currentPath) return;
		const initialContent = `# ${title}\n\n`;
		try {
			await createPageInApi(`${currentPath}/index.md`, initialContent);
			set({ content: initialContent, isDirty: false, loadStatus: "ok" });
			saveCachedPage({
				path: currentPath,
				content: initialContent,
				frontmatter: null,
			});
		} catch {
			// silently ignore — user can retry
		}
	},

	clear: () => {
		if (saveTimer) clearTimeout(saveTimer);
		if (statusTimer) clearTimeout(statusTimer);
		set({
			currentPath: null,
			content: "",
			frontmatter: null,
			saveStatus: "idle",
			loadStatus: "idle",
			isDirty: false,
			isLoading: false,
			lastSavedAt: null,
			currentRevision: null,
		});
	},

	syncRevision: (revision: number) => {
		set({ currentRevision: revision });
	},
}));
