/**
 * The toggle that shows or hides the annotations panel beside the text.
 *
 * This is the outline's former overlay-button pattern: a small backdrop-blurred
 * control in the editor's top-right corner at `top-10`. The outline has since
 * moved to a pushing left column, so the right corner is again free at every
 * width and the button needs no stacking offset below it.
 *
 * It is only a SHOW/HIDE control. The All / Comments / Changes tabs and the
 * panel's hide toggle live on the panel's own header, so there is one surface
 * rather than a floating box of tabs over a separate reading panel, and the two
 * can never overlap.
 *
 * Rendered only when the document has something to annotate, so it never
 * advertises an empty panel.
 */

import { ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	panelContents,
	useAnnotationPanelStore,
} from "@/stores/annotation-panel-store";

export function AnnotationsButton() {
	const commentCount = useAnnotationPanelStore((s) => s.commentCount);
	const suggestionCount = useAnnotationPanelStore((s) => s.suggestionCount);
	const panelOpen = useAnnotationPanelStore((s) => s.panelOpen);
	const tab = useAnnotationPanelStore((s) => s.tab);
	const togglePanel = useAnnotationPanelStore((s) => s.togglePanel);

	const total = commentCount + suggestionCount;

	// The badge counts what the panel would actually show, from the SAME function
	// the panel uses to decide what to render, so the two cannot disagree.
	const contents = panelContents({
		commentCount,
		suggestionCount,
		panelOpen,
		tab,
	});
	const badge = contents.comments + contents.suggestions;

	// Nothing to annotate: no control at all. A button that opens an empty panel is
	// worse than no button. While the panel is showing there is also no control
	// here — the hide toggle lives on the panel's own header row, symmetric with
	// the outline column — so the corner button only exists when the panel is closed.
	if (total === 0) return null;
	if (panelOpen && badge > 0) return null;

	return (
		<button
			type="button"
			onClick={togglePanel}
			aria-label="Comments and suggested changes"
			aria-expanded={panelOpen}
			title={`${total} outstanding ${total === 1 ? "item" : "items"}`}
			data-annotations-button
			className={cn(
				"absolute right-2 top-10 z-30 flex items-center gap-1.5 rounded border px-2 py-1 text-[10px] shadow-sm backdrop-blur transition-colors",
				"bg-background/80 border-border/60 text-muted-foreground/70",
				"hover:bg-accent hover:text-foreground",
				panelOpen && "bg-accent text-foreground",
			)}
		>
			<ListChecks className="h-3.5 w-3.5" />
			{badge > 0 && <span className="tabular-nums">{badge}</span>}
		</button>
	);
}