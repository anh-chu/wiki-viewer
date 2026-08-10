"use client";
import type { Editor } from "@tiptap/react";

import { ReadTimeExperiment } from "./read-time";
import { BreadcrumbExperiment } from "./breadcrumb";
import { AnchorFlashExperiment } from "./anchor-flash";
import { CollapsibleExperiment } from "./collapsible";

export interface ExperimentProps {
	editor: Editor | null;
	scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Mounts every reading-UX feature. Always-on: read-time, anchor flash, collapsible, breadcrumb.
 */
export function ReadingExperiments(props: ExperimentProps) {
	return (
		<>
			<ReadTimeExperiment {...props} />
			<BreadcrumbExperiment {...props} />
			<AnchorFlashExperiment {...props} />
			<CollapsibleExperiment {...props} />
		</>
	);
}
