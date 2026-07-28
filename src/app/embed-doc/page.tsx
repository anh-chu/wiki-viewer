"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { KBEditor } from "@/components/editor/editor";
import { useEditorStore } from "@/stores/editor-store";

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Whether `origin` is trusted for the given explicit parent param value.
 *
 * Trust rules, in order:
 *   1. Loopback — always trusted (local development).
 *   2. Same-origin — the embed lives on our own domain.
 *   3. Explicit `parent` query param — the origin the embedding host declared
 *      and the middleware already validated via api_key before this page rendered.
 */
function originIsAllowed(origin: string, parentParam: string | null): boolean {
	if (LOOPBACK_ORIGIN.test(origin)) return true;
	if (typeof window !== "undefined" && origin === window.location.origin) return true;
	if (parentParam && origin === parentParam) return true;
	return false;
}

interface RenderContentMessage {
	type: "render-content";
	path: string;
	content: string;
}

function isRenderContentMessage(data: unknown): data is RenderContentMessage {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	return d.type === "render-content" && typeof d.path === "string" && typeof d.content === "string";
}

function EmbedDocInner() {
	const searchParams = useSearchParams();
	const parentParam = searchParams.get("parent") ?? null;

	const [ready, setReady] = useState(false);
	const [received, setReceived] = useState(false);

	useEffect(() => {
		const warnedOrigins = new Set<string>();

		const handler = (e: MessageEvent) => {
			if (!isRenderContentMessage(e.data)) return;

			if (!originIsAllowed(e.origin, parentParam)) {
				if (!warnedOrigins.has(e.origin)) {
					warnedOrigins.add(e.origin);
					console.warn(
						`[embed-doc] Rejected render-content from untrusted origin: ${e.origin}`,
					);
				}
				return;
			}

			const { path, content } = e.data;

			useEditorStore.setState({
				currentPath: path,
				content,
				frontmatter: null,
				isLoading: false,
				loadStatus: "ok",
				isDirty: false,
				currentRevision: null,
				saveStatus: "saved",
			});

			setReceived(true);
		};

		window.addEventListener("message", handler);

		// Signal readiness AFTER the listener is installed, so the parent can
		// push immediately without racing.
		if (window.parent && window.parent !== window) {
			const targetOrigin = parentParam ?? "*";
			window.parent.postMessage({ type: "embed-doc-ready" }, targetOrigin);
		}

		setReady(true);

		return () => {
			window.removeEventListener("message", handler);
		};
	}, [parentParam]);

	if (!received) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground min-h-screen">
				<div className="text-center space-y-3">
					<p className="text-sm text-muted-foreground/70">
						{ready ? "Waiting for content..." : "Initializing..."}
					</p>
				</div>
			</div>
		);
	}

	// KBEditor's every branch starts with flex-1, so it needs a flex parent with a
	// real height or it collapses to zero and renders an empty page. The shared-doc
	// page gets this from its own layout; standalone here we must supply it.
	return (
		<div className="flex flex-col h-screen min-h-0">
			<KBEditor mode="viewing" />
		</div>
	);
}

export default function EmbedDocPage() {
	return (
		<Suspense
			fallback={
				<div className="flex-1 flex items-center justify-center text-muted-foreground min-h-screen">
					<div className="text-center space-y-3">
						<p className="text-sm text-muted-foreground/70">Initializing...</p>
					</div>
				</div>
			}
		>
			<EmbedDocInner />
		</Suspense>
	);
}
