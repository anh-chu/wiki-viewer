import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { safeRootPath } from "@/lib/root-dir";

const VALID_DIRS = new Set(["entities", "concepts", "comparisons"]);
const SLUG_RE = /^[a-z0-9-]+$/;

type PageBody = {
	dir?: string;
	slug?: string;
	title?: string;
};

function humanizeSlug(slug: string): string {
	return slug
		.split("-")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function dateStampUTC(): string {
	return new Date().toISOString().slice(0, 10);
}

function singularType(
	dir: "entities" | "concepts" | "comparisons",
): "entity" | "concept" | "comparison" {
	if (dir === "entities") return "entity";
	if (dir === "concepts") return "concept";
	return "comparison";
}

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const body: PageBody = await request.json();
	const { dir, slug } = body;

	if (!dir || !VALID_DIRS.has(dir)) {
		return NextResponse.json({ error: "Invalid dir" }, { status: 400 });
	}
	if (!slug || !SLUG_RE.test(slug)) {
		return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
	}

	const relPath = `${dir}/${slug}.md`;
	const filePath = safeRootPath(relPath);
	if (!filePath)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	try {
		await stat(filePath);
		return NextResponse.json(
			{ error: "Page already exists", path: relPath },
			{ status: 409 },
		);
	} catch (e: unknown) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			return NextResponse.json(
				{ error: "Failed to create page" },
				{ status: 500 },
			);
		}
	}

	const safeDir = dir as "entities" | "concepts" | "comparisons";
	const resolvedTitle =
		typeof body.title === "string" && body.title.trim().length > 0
			? body.title
			: humanizeSlug(slug);
	const content = `---\ntitle: ${resolvedTitle}\ntype: ${singularType(safeDir)}\ntags: []\nupdated: ${dateStampUTC()}\n---\n\n# ${resolvedTitle}\n\n`;

	try {
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content, "utf-8");
		return NextResponse.json({ ok: true, path: relPath, slug, dir: safeDir });
	} catch {
		return NextResponse.json(
			{ error: "Failed to create page" },
			{ status: 500 },
		);
	}
}
