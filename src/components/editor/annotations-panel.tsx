/**
 * The annotations panel: every comment and every suggestion in one list.
 *
 * This is the surface that ANSWERS "what is outstanding in this document?" — the
 * anchored margin beside the text cannot, because it only shows one card per
 * commented block and gives no account of what is further down. Google Docs splits the
 * two the same way: anchored cards beside the text, and a list of everything in
 * a panel.
 *
 * It is deliberately stacked UNDER the outline overlay rather than sharing a row with
 * it — both are anchored to the editor's top-right corner, and the outline is the
 * daily-use control. `top-9` clears the outline's own toggle so the two never
 * cover each other, and the panel stays closed by default so it cannot obscure
 * the outline at all until it is asked for.
 *
 * Suggestions live ONLY here. They are marks over a few words inside a block, so
 * aligning a card to the block's top edge told the reader nothing about which
 * words were affected; the panel lists them with the words they change, which is
 * the information the anchored position was trying and failing to convey.
 */

import { useCallback, useState } from "react";
import { MessageSquare, Sparkles, X } from "lucide-react";
import type { MarkId } from "@/lib/proof/suggestion-mark";
import { cn } from "@/lib/utils";
import type { MarginThread } from "./comment-margin";

/**
 * A pending suggested change, as the panel needs to draw it.
 *
 * `id` is the mark's `data-id`, which is also what settles it: accepting or rejecting
 * calls the vendored `applySuggestion(id, from, to)`, so the card needs the range too.
 * The id keeps its ORIGINAL type — see `MarkId` — because the library compares with
 * strict equality and generates numbers.
 */
export interface PanelSuggestion {
	/** The mark's `data-id`, keeping its original type — see `MarkId`. */
	id: MarkId;
	kind: "insert" | "remove" | "modify";
	from: number;
	to: number;
	/** The text the mark covers, for the card's one-line summary. */
	text: string;
}

interface Props {
	threads: readonly MarginThread[];
	suggestions: readonly PanelSuggestion[];
	/** Accept a suggested change, identified by its mark id and range. */
	onAcceptSuggestion: (id: MarkId, from: number, to: number) => void;
	/** Reject a suggested change, identified by its mark id and range. */
	onRejectSuggestion: (id: MarkId, from: number, to: number) => void;
	/** Jump the document to a comment's anchored block. */
	onJumpToRef?: (blockRef: string) => void;
	/**
	 * Open the anchored card for a comment and scroll it into view.
	 *
	 * The panel cannot show WHERE a comment sits, so this is how a reader gets
	 * from the list back to the text.
	 */
	onFocusThread?: (blockRef: string) => void;
}

/**
 * What the panel shows for a given filter, and whether that is worth showing.
 *
 * Pure, and exported, because it is the panel's only real logic: the counts that
 * drive the trigger badge must be the counts the list renders, and a filter with
 * nothing behind it has to be distinguishable from a filter that is merely unused.
 * A component-only version of this could disagree with its own badge.
 */
export function panelView(
	filter: PanelFilter,
	threads: readonly MarginThread[],
	suggestions: readonly PanelSuggestion[],
): {
	total: number;
	comments: readonly MarginThread[];
	suggestions: readonly PanelSuggestion[];
	/** The filter matched nothing, so the body should say so rather than sit empty. */
	empty: boolean;
} {
	const comments = filter === "suggestions" ? [] : threads;
	const shown = filter === "comments" ? [] : suggestions;
	return {
		total: threads.length + suggestions.length,
		comments,
		suggestions: shown,
		empty: comments.length === 0 && shown.length === 0,
	};
}

export type PanelFilter = "all" | "comments" | "suggestions";

export function AnnotationsPanel({
	threads,
	suggestions,
	onAcceptSuggestion,
	onRejectSuggestion,
	onJumpToRef,
	onFocusThread,
}: Props) {
	const [open, setOpen] = useState(false);
	const [tab, setTab] = useState<PanelFilter>("all");

	// One definition drives the badge, the list and the empty state, so a badge can
	// never advertise a number the list does not contain.
	const view = panelView(tab, threads, suggestions);
	const total = view.total;
	const showComments = view.comments.length > 0;
	const showSuggestions = view.suggestions.length > 0;

	const toggle = useCallback(() => setOpen((o) => !o), []);

	// Nothing to show and nothing open: no trigger at all. A button that opens an
	// empty panel is worse than no button.
	if (total === 0) return null;

	return (
		// `top-20` clears the outline's own toggle, which sits at `right-2 top-10` on
		// the same corner below `xl`. Two controls at one position is not a stacking
		// question - one of them is simply unreachable - so the panel is offset below it
		// rather than fighting it for the pixel. On `xl` and up the outline becomes the
		// rail at `right-1 top-10`, which leaves this corner to the panel alone.
		<div className="absolute right-2 top-20 z-20 xl:top-10" data-annotations-panel>
			<button
				type="button"
				onClick={toggle}
				aria-label="Comments and suggestions"
				aria-expanded={open}
				title={
					total === 0
						? "Comments and suggestions"
						: `${total} outstanding ${total === 1 ? "item" : "items"}`
				}
				className={cn(
					"flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] shadow-sm transition-colors",
					"bg-background/80 backdrop-blur border-border/60 text-muted-foreground/70",
					"hover:text-foreground hover:bg-accent",
					open && "text-foreground bg-accent",
				)}
			>
				<MessageSquare className="h-3.5 w-3.5" />
				{total > 0 && <span className="tabular-nums">{total}</span>}
			</button>

			{open && (
				<div
					className="absolute right-0 top-9 z-10 flex w-[21rem] max-h-[60vh] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
					role="dialog"
					aria-label="Comments and suggestions"
				>
					{/* Header: the two filters double as the panel's title row. */}
					<div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
						<FilterButton
							active={tab === "all"}
							onClick={() => setTab("all")}
							label="All"
							count={total}
						/>
						<FilterButton
							active={tab === "comments"}
							onClick={() => setTab("comments")}
							label="Comments"
							count={threads.length}
						/>
						<FilterButton
							active={tab === "suggestions"}
							onClick={() => setTab("suggestions")}
							label="Changes"
							count={suggestions.length}
						/>
						<button
							type="button"
							onClick={() => setOpen(false)}
							aria-label="Close panel"
							className="ml-auto rounded p-0.5 text-muted-foreground/50 hover:bg-accent hover:text-foreground transition-colors"
						>
							<X className="h-3.5 w-3.5" />
						</button>
					</div>

					{/* The scroll lives HERE, on the body, so the filter row above it stays
					    put while a long list scrolls under it. */}
					<div className="min-h-0 flex-1 overflow-y-auto p-2">
						{showSuggestions && (
							<div className="flex flex-col gap-1.5">
								{showComments && (
									<SectionLabel
										icon={<Sparkles className="h-3 w-3" />}
										label="Suggested changes"
										count={suggestions.length}
									/>
								)}
								{suggestions.map((sg) => (
									<SuggestionCard
										key={`suggestion:${String(sg.id)}`}
										suggestion={sg}
										onAccept={() => onAcceptSuggestion(sg.id, sg.from, sg.to)}
										onReject={() => onRejectSuggestion(sg.id, sg.from, sg.to)}
									/>
								))}
							</div>
						)}

						{showComments && (
							<div
								className={cn(
									"flex flex-col gap-1.5",
									showSuggestions && "mt-3",
								)}
							>
								{showSuggestions && (
									<SectionLabel
										icon={<MessageSquare className="h-3 w-3" />}
										label="Comments"
										count={threads.length}
									/>
								)}
								{threads.map((thread) => (
									<PanelCommentCard
										key={thread.blockRef}
										thread={thread}
										onOpen={() => {
											onJumpToRef?.(thread.blockRef);
											onFocusThread?.(thread.blockRef);
										}}
									/>
								))}
							</div>
						)}

						{/* A filter with nothing behind it says so, rather than showing an
						    empty box the reader has to interpret. */}
						{view.empty && (
							<p className="px-1 py-3 text-center text-[11px] text-muted-foreground/60">
								{tab === "comments" ? "No comments" : "No suggested changes"}
							</p>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

function FilterButton({
	active,
	onClick,
	label,
	count,
}: {
	active: boolean;
	onClick: () => void;
	label: string;
	count: number;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={cn(
				"rounded px-1.5 py-0.5 text-[10px] transition-colors",
				active
					? "bg-primary/10 font-medium text-primary"
					: "text-muted-foreground/60 hover:bg-accent hover:text-foreground",
			)}
		>
			{label}
			{count > 0 && <span className="ml-1 tabular-nums opacity-60">{count}</span>}
		</button>
	);
}

function SectionLabel({
	icon,
	label,
	count,
}: {
	icon: React.ReactNode;
	label: string;
	count: number;
}) {
	return (
		<div className="flex items-center gap-1 px-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
			{icon}
			<span>{label}</span>
			<span className="tabular-nums">{count}</span>
		</div>
	);
}

/**
 * A pending suggested change: what it is, the words it covers, and the two decisions.
 *
 * The quoted text is the whole point of the card — it is what the anchored column
 * could not show, because a mark covers a few words rather than a block edge.
 */
function SuggestionCard({
	suggestion,
	onAccept,
	onReject,
}: {
	suggestion: PanelSuggestion;
	onAccept: () => void;
	onReject: () => void;
}) {
	const isRemoval = suggestion.kind === "remove";
	return (
		<div className="w-full rounded-lg border border-border bg-popover p-2.5 shadow-sm">
			<div className="flex items-start gap-2">
				<span
					aria-hidden="true"
					className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-[9px] font-medium uppercase text-amber-600"
				>
					s
				</span>
				<span className="min-w-0 flex-1">
					<span className="block text-[11px] font-medium text-foreground">
						{isRemoval ? "Suggested deletion" : "Suggested insertion"}
					</span>
					<span
						className={cn(
							"mt-0.5 block line-clamp-3 text-[11px] leading-snug text-muted-foreground",
							// A deletion is shown struck through, so the card says what it
							// proposes before the reader reads a word of it.
							isRemoval && "line-through decoration-inherit",
						)}
					>
						{suggestion.text || "(no text)"}
					</span>
				</span>
			</div>
			<div className="mt-2 flex items-center gap-2">
				<button
					type="button"
					onClick={onReject}
					className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					Reject
				</button>
				<button
					type="button"
					onClick={onAccept}
					className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					Approve
				</button>
			</div>
		</div>
	);
}

/**
 * A comment as the panel lists it, with a jump back to its anchor.
 *
 * The anchored column shows the full thread; the panel is a locator, so it shows
 * who said what in one line and gets the reader to the card that can be replied
 * to.
 */
function PanelCommentCard({
	thread,
	onOpen,
}: {
	thread: MarginThread;
	onOpen: () => void;
}) {
	const first = thread.comments[0];
	if (!first) return null;
	const replies = thread.comments.reduce((n, c) => n + c.turns.length, 0) - 1;
	const resolved = thread.comments.every((c) => c.resolved);

	return (
		<button
			type="button"
			onClick={onOpen}
			className="w-full rounded-lg border border-border bg-popover p-2.5 text-left shadow-sm transition-colors hover:border-ring/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
		>
			<div className="flex items-start gap-2">
				<span
					aria-hidden="true"
					className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-medium uppercase text-primary"
				>
					{(first.turns[0]?.by ?? "h").replace(/^human$/, "h").slice(0, 1)}
				</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-[11px] font-medium text-foreground">
						{first.turns[0]?.by ?? "human"}
					</span>
					<span className="mt-0.5 block line-clamp-3 text-[11px] leading-snug text-muted-foreground">
						{first.turns[0]?.text}
					</span>
					{replies > 0 && (
						<span className="mt-1 block text-[10px] text-muted-foreground/60">
							{replies} {replies === 1 ? "reply" : "replies"}
						</span>
					)}
				</span>
				{resolved && (
					<span className="shrink-0 text-[10px] text-muted-foreground/50">resolved</span>
				)}
			</div>
		</button>
	);
}