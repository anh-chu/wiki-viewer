"use client";

import { useCallback, useState } from "react";
import { wsFetch } from "@/lib/workspace-client";
import type { AddItemInput, TweakItem, TweakPhase, TweakSession } from "./tweak-types";
import { clearTweakItems, removeTweakItem, upsertTweakItem } from "./tweak-queue";

let counter = 0;
function mintId(): string {
	counter += 1;
	return `tw_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/**
 * Shared Tweak session: owns the queue model (with dedup by targetKey), the
 * coarse phase, the presence gate, and clear/remove paths. Content-kind
 * adapters build on top of this for surface-specific network + rendering.
 *
 * Dedup contract: {@link TweakSession.addItem} never pushes a duplicate — if an
 * item with the same `targetKey` is already queued it UPDATES that item's
 * instruction/snippet in place. This fixes the selection-stacking bug and keeps
 * the count honest when re-picking the same target.
 */
export function useTweakSession(opts: { attached: boolean }): TweakSession {
	const [items, setItems] = useState<TweakItem[]>([]);
	const [phase, setPhase] = useState<TweakPhase>("targeting");

	const addItem = useCallback((input: AddItemInput): string => {
		let resultId = input.itemId ?? mintId();
		setItems((prev) => {
			const result = upsertTweakItem(prev, input, () => resultId);
			resultId = result.itemId;
			return result.items;
		});
		return resultId;
	}, []);

	const removeItem = useCallback((itemId: string) => {
		setItems((prev) => removeTweakItem(prev, itemId));
	}, []);

	const clear = useCallback(() => {
		setItems(clearTweakItems());
	}, []);

	const refreshPresence = useCallback(async () => {
		try {
			await wsFetch("/api/wiki/live/status");
		} catch {
			/* presence poll is best-effort */
		}
	}, []);

	return {
		items,
		addItem,
		removeItem,
		clear,
		phase,
		setPhase,
		attached: opts.attached,
		refreshPresence,
	};
}
