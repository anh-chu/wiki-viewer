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
 * Mounts every reading-UX experiment. Each child gates itself on its own
 * flag from useExperiment(...) and renders null when off, so this can be
 * mounted unconditionally with no cost when all experiments are disabled.
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
