"use client";

import { useAIPanelStore } from "@/stores/ai-panel-store";
import { wsFetch } from "@/lib/workspace-client";
import { useEffect, useState } from "react";

interface Props { enabled?: boolean; className?: string; }

/** Honest live-channel indicator. Brief poll gaps stay connected for 10 seconds. */
export function LivePresence({ enabled = true, className = "" }: Props) {
	const [attached, setAttached] = useState(false);
	const [lastSeen, setLastSeen] = useState(0);
	useEffect(() => {
		if (!enabled) return;
		let alive = true;
		const poll = async () => {
			try {
				const res = await wsFetch("/api/wiki/live/status");
				if (!res.ok || !alive) return;
				const data = (await res.json()) as { attached?: boolean };
				if (data.attached) setLastSeen(Date.now());
				setAttached(Boolean(data.attached));
			} catch { /* keep grace state */ }
		};
		void poll();
		const timer = window.setInterval(poll, 3000);
		return () => { alive = false; window.clearInterval(timer); };
	}, [enabled]);
	useEffect(() => {
		if (!attached || !lastSeen) return;
		const timer = window.setInterval(() => {
			if (Date.now() - lastSeen > 10000) setAttached(false);
		}, 1000);
		return () => window.clearInterval(timer);
	}, [attached, lastSeen]);
	const live = attached && Date.now() - lastSeen <= 10000;
	return live ? (
		<span className={`text-xs text-emerald-600 ${className}`}>● listening</span>
	) : (
		<button type="button" className={`text-xs text-amber-600 animate-pulse ${className}`} onClick={() => useAIPanelStore.getState().open()} title="Ask your agent to call live_attach, then keep calling live_poll.">
			◌ no agent — Connect
		</button>
	);
}

export function useLiveAttached(): boolean {
	const [lastSeen, setLastSeen] = useState(0);
	useEffect(() => {
		let alive = true;
		const poll = async () => { try { const r = await wsFetch("/api/wiki/live/status"); if (alive && r.ok && (await r.json()).attached === true) setLastSeen(Date.now()); } catch {} };
		void poll(); const t = window.setInterval(poll, 3000); return () => { alive = false; window.clearInterval(t); };
	}, []);
	useEffect(() => { const t = window.setInterval(() => setLastSeen((v) => v && Date.now() - v > 10000 ? 0 : v), 1000); return () => window.clearInterval(t); }, []);
	return lastSeen > 0 && Date.now() - lastSeen <= 10000;
}
