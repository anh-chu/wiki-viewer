import type { AddItemInput, TweakItem } from "./tweak-types";

/** Dispatch labels shared by content-kind adapters. */
export const TWEAK_DISPATCH_LABELS = {
	markdown: "Rewrite",
	html: "Apply",
} as const;

/**
 * Add a queued item or update its existing target in place. Kept independent of
 * React so queue behavior can be reused and tested directly.
 */
export function upsertTweakItem(
	items: TweakItem[],
	input: AddItemInput,
	mintId: () => string,
): { items: TweakItem[]; itemId: string } {
	const index = items.findIndex((item) => item.targetKey === input.targetKey);
	if (index >= 0) {
		const itemId = items[index].itemId;
		const next = [...items];
		next[index] = {
			...next[index],
			displaySnippet: input.displaySnippet,
			instruction: input.instruction,
		};
		return { items: next, itemId };
	}

	const itemId = input.itemId ?? mintId();
	return {
		items: [
			...items,
			{
				itemId,
				targetKey: input.targetKey,
				displaySnippet: input.displaySnippet,
				instruction: input.instruction,
			},
		],
		itemId,
	};
}

/** Remove one selected target from the queue. */
export function removeTweakItem(items: TweakItem[], itemId: string): TweakItem[] {
	return items.filter((item) => item.itemId !== itemId);
}

/** Clear every selected target. */
export function clearTweakItems(): TweakItem[] {
	return [];
}
