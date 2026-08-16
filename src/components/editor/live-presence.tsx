"use client";

import { wsFetch } from "@/lib/workspace-client";
import { useEffect, useState } from "react";

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
