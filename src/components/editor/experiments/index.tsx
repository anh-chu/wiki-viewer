"use client";
import type { Editor } from "@tiptap/react";

import { FocusModeExperiment } from "./focus-mode";
import { ReadTimeExperiment } from "./read-time";
import { BreadcrumbExperiment } from "./breadcrumb";
import { AnchorFlashExperiment } from "./anchor-flash";
import { CollapsibleExperiment } from "./collapsible";

export interface ExperimentProps {
	editor: Editor | null;
	scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Mounts every reading-UX feature. Some are always-on (read-time, anchor
 * flash, collapsible); focus mode and breadcrumb still gate on their own
 * lab flag and render null when off.
 */
export function ReadingExperiments(props: ExperimentProps) {
	return (
		<>
			<FocusModeExperiment {...props} />
			<ReadTimeExperiment {...props} />
			<BreadcrumbExperiment {...props} />
			<AnchorFlashExperiment {...props} />
			<CollapsibleExperiment {...props} />
		</>
	);
}
