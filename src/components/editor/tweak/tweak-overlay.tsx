"use client";

import type { ContentKindAdapter } from "./tweak-types";
import { TweakQueueBar } from "./tweak-queue-bar";

/**
 * Shared Tweak overlay shell. Renders the surface's targeting UI, the shared
 * queue bar, and the surface's run-lifecycle panel — delegating all
 * content-specific rendering to the content-kind adapter's slot functions.
 */
export function TweakOverlay({ adapter }: { adapter: ContentKindAdapter }) {
	return (
		<>
			{adapter.renderTargeting()}
			<TweakQueueBar adapter={adapter} />
			{adapter.renderRunPanel()}
		</>
	);
}
