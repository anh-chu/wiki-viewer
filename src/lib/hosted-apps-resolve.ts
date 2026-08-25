/**
 * Slug → runtime target resolution for the Hosted Apps slug route.
 *
 * Kept separate from the registry (which owns only the durable mapping) and from
 * the route (which owns HTTP concerns) so the resolution can be proof-tested at
 * the seam the ticket cares about: entry → workspace/relPath/running-port,
 * WITHOUT launching a real child. For a node entry the running port is read from
 * the app runner on every call — never persisted, never baked into a URL — so a
 * restart that changes the port is picked up on the next request.
 */
import { getStatus, type AppStatus } from "@/lib/app-runner";
import { getBySlug, type HostedApp } from "@/lib/hosted-apps";

export type HostedTarget =
	| {
			kind: "html";
			entry: HostedApp;
			workspaceId: string;
			relPath: string;
	  }
	| {
			kind: "node";
			entry: HostedApp;
			workspaceId: string;
			relPath: string;
			/** Fresh per call from the app runner; undefined when not running. */
			port: number | undefined;
			status: AppStatus;
	  };

/**
 * Resolve a slug to its runtime target. Returns null for an unknown slug.
 * For node entries the port/status are read live from the app runner.
 */
export async function resolveHostedTarget(slug: string): Promise<HostedTarget | null> {
	const entry = await getBySlug(slug);
	if (!entry) return null;

	if (entry.type === "html") {
		return {
			kind: "html",
			entry,
			workspaceId: entry.workspaceId,
			relPath: entry.relPath,
		};
	}

	const runtime = getStatus(entry.workspaceId, entry.relPath);
	return {
		kind: "node",
		entry,
		workspaceId: entry.workspaceId,
		relPath: entry.relPath,
		port: runtime.port,
		status: runtime.status,
	};
}
