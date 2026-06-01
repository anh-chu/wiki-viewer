import { authHeaders } from "./client-auth";
import type { SuggestionKind } from "./types";

interface PostResult {
	ok: boolean;
	stale: boolean;
	newRevision?: number;
}

async function postSuggestionOp(
	path: string,
	baseRevision: number,
	op: Record<string, unknown>,
): Promise<PostResult> {
	const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
	const res = await fetch(`/api/agent/files/${encoded}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": crypto.randomUUID(),
			...authHeaders(),
		},
		body: JSON.stringify({ baseRevision, by: "human", ops: [op] }),
	});
	if (res.status === 409) {
		const data = (await res.json()) as {
			code?: string;
			snapshot?: { revision?: number };
		};
		if (data.code === "STALE_REVISION" && data.snapshot?.revision !== undefined) {
			return { ok: false, stale: true, newRevision: data.snapshot.revision };
		}
		return { ok: false, stale: false };
	}
	return { ok: res.ok, stale: false };
}

/**
 * Emit a human suggestion for a block, retrying once on a stale-revision 409.
 *
 * `getRevision` returns the freshest known snapshot revision, `refresh`
 * reloads the snapshot+sidecar so a retry can use the latest revision.
 */
export async function captureSuggestion(args: {
	path: string;
	ref: string;
	kind: SuggestionKind;
	markdown?: string;
	basisDetail?: string;
	getRevision: () => number;
	refresh: () => Promise<void>;
}): Promise<boolean> {
	const { path, ref, kind, markdown, basisDetail, getRevision, refresh } = args;
	const op: Record<string, unknown> = {
		type: "suggestion.add",
		ref,
		kind,
		basis: "suggested",
	};
	if (kind !== "delete") op.markdown = markdown ?? "";
	if (basisDetail) op.basisDetail = basisDetail;

	let result = await postSuggestionOp(path, getRevision(), op);
	if (!result.ok && result.stale && result.newRevision !== undefined) {
		await refresh();
		result = await postSuggestionOp(path, result.newRevision, op);
	}
	return result.ok;
}
