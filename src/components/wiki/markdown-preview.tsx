"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { markdownToHtml } from "@/lib/markdown/to-html";
import { useWikiSlugsStore } from "@/stores/wiki-slugs-store";

interface MarkdownPreviewProps {
	markdown: string;
	pagePath: string;
	onNavigate: (targetPath: string, anchor: string | null) => void;
}

export function MarkdownPreview({
	markdown,
	pagePath,
	onNavigate,
}: MarkdownPreviewProps) {
	const [html, setHtml] = useState<string>("");
	const containerRef = useRef<HTMLDivElement>(null);

	// Recompute HTML whenever markdown or pagePath changes.
	useEffect(() => {
		let cancelled = false;
		markdownToHtml(markdown, { pagePath, sanitize: true }).then((result) => {
			if (!cancelled) setHtml(result);
		});
		return () => {
			cancelled = true;
		};
	}, [markdown, pagePath]);

	// Delegated click handler: wiki-links navigate; external links get _blank.
	const handleClick = useCallback(
		(e: MouseEvent) => {
			const link = (e.target as HTMLElement).closest(
				"a",
			) as HTMLAnchorElement | null;
			if (!link) return;

			if (link.dataset.wikiLink === "true") {
				e.preventDefault();
				const slug = link.dataset.slug ?? "";
				if (!slug) return;
				const dir = useWikiSlugsStore.getState().getDir(slug);
				if (!dir) return; // broken link - no nav
				const targetPath =
					dir === "root" ? `${slug}.md` : `${dir}/${slug}.md`;
				const anchor = link.dataset.anchor ?? null;
				onNavigate(targetPath, anchor);
				return;
			}

			// External links: ensure _blank + noreferrer.
			const href = link.getAttribute("href") ?? "";
			if (/^https?:\/\//.test(href)) {
				if (!link.target) {
					link.setAttribute("target", "_blank");
					link.setAttribute("rel", "noreferrer");
				}
				return;
			}

			// Anchor-only hrefs: let browser scroll natively.
		},
		[onNavigate],
	);

	// Attach and detach click handler whenever html or handler changes.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		// Set _blank on external links at bind time so they work without JS.
		el.querySelectorAll<HTMLAnchorElement>("a[href^='http']").forEach((a) => {
			if (!a.target) {
				a.setAttribute("target", "_blank");
				a.setAttribute("rel", "noreferrer");
			}
		});
		el.addEventListener("click", handleClick);
		return () => el.removeEventListener("click", handleClick);
	}, [html, handleClick]);

	// Apply broken-link styling after render and whenever slug store updates.
	const slugsLoadedAt = useWikiSlugsStore((s) => s.loadedAt);
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const store = useWikiSlugsStore.getState();
		el.querySelectorAll<HTMLAnchorElement>(
			'a[data-wiki-link="true"]',
		).forEach((link) => {
			const slug = link.dataset.slug ?? "";
			if (slug && !store.has(slug)) {
				link.dataset.broken = "true";
			} else {
				delete link.dataset.broken;
			}
		});
	}, [html, slugsLoadedAt]);

	// Disable task-list checkboxes in read-only viewer.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		el.querySelectorAll<HTMLInputElement>(
			'input[type="checkbox"]',
		).forEach((input) => {
			input.disabled = true;
		});
	}, [html]);

	return (
		<div
			ref={containerRef}
			className="tiptap md-preview"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized by rehype-sanitize
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
