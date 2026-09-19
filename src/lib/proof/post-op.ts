"use client";

/**
 * The one write path to the tier-2 proof API.
 *
 * Extracted from `suggest-edit-popover.tsx`, which used to hold it alongside a
 * now-removed block-suggest UI. It is not suggestion-specific: accept/reject and
 * the comment ops post through the same function, so it lives on its own here.
 */

import { clientId } from "@/lib/client-id";
import { authHeaders } from "@/lib/proof/client-auth";
import { wsFetch } from "@/lib/workspace-client";
import type { Snapshot } from "@/lib/proof/types";

export async function postOp(
	path: string,
	baseRevision: number,
	ops: object[],
): Promise<{
	ok: boolean;
	stale: boolean;
	/**
	 * The revision the server left behind, on success.
	 *
	 * Callers must adopt it: it is the `baseRevision` their NEXT request sends, so a
	 * caller that drops it re-sends a revision the server has already passed and is
	 * refused `409 STALE_REVISION` for every write thereafter.
	 */
	revision?: number;
	newRevision?: number;
	/** Machine-readable failure code from the server, when it sent one. */
	code?: string;
	/** Human-readable failure message from the server, when it sent one. */
	message?: string;
	snapshot?: Snapshot;
}> {
	const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
	const res = await wsFetch(`/api/agent/files/${encoded}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": clientId(),
			...authHeaders(),
		},
		body: JSON.stringify({ baseRevision, by: "human", ops }),
	});
	if (res.status === 409) {
		const data = (await res.json()) as { code?: string; message?: string; snapshot?: { revision?: number } };
		if (data.code === "STALE_REVISION" && data.snapshot?.revision !== undefined) {
			return { ok: false, stale: true, newRevision: data.snapshot.revision, code: data.code };
		}
		// Carry the code and message through instead of collapsing every 409 to
		// "not stale". Discarding them is what made a refused suggestion write
		// indistinguishable from a transport failure at the call site.
		return { ok: false, stale: false, code: data.code, message: data.message };
	}
	if (!res.ok) return { ok: false, stale: false, code: `HTTP_${res.status}` };
	// The response's own `revision` is the authoritative base for the next write. It is
	// read here because callers previously had no way to reach it, which is how a
	// successful write could still leave the client stale.
	const body = (await res.json()) as Snapshot;
	return {
		ok: true,
		stale: false,
		snapshot: body,
		revision: typeof body.revision === "number" ? body.revision : undefined,
	};
}
