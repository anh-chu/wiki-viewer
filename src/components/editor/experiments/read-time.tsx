"use client";

import { useEffect, useRef, useState } from "react";
import type { ExperimentProps } from "./index";

export function ReadTimeExperiment({ editor, scrollContainerRef }: ExperimentProps) {
	const [minutes, setMinutes] = useState(0);
	const [progress, setProgress] = useState(0);
	const [size, setSize] = useState({ w: 0, h: 0 });
	const pillRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!editor) return;

		const compute = () => {
			const words = editor.state.doc.textContent.match(/\S+/g)?.length ?? 0;
			setMinutes(Math.max(1, Math.round(words / 220)));
		};

		compute();
		let t: ReturnType<typeof setTimeout> | null = null;
		const update = () => {
			if (t) clearTimeout(t);
			t = setTimeout(compute, 250);
		};

		editor.on("update", update);
		return () => {
			if (t) clearTimeout(t);
			editor.off("update", update);
		};
	}, [editor]);

	useEffect(() => {
		const host = scrollContainerRef.current;
		if (!host) return;

		const onScroll = () => {
			const max = host.scrollHeight - host.clientHeight;
			setProgress(max <= 0 ? 0 : Math.min(1, Math.max(0, host.scrollTop / max)));
		};

		onScroll();
		host.addEventListener("scroll", onScroll, { passive: true });
		return () => host.removeEventListener("scroll", onScroll);
	}, [scrollContainerRef, minutes]);

	useEffect(() => {
		const el = pillRef.current;
		if (!el) return;
		const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const remaining = Math.max(0, Math.ceil(minutes * (1 - progress)));
	const label = progress >= 0.995 ? "Done" : progress > 0.02 ? `${remaining} min left` : `${minutes} min read`;

	return (
		<div
			ref={pillRef}
			className="absolute bottom-3 left-3 z-20 pointer-events-none rounded-full border border-border/60 bg-background/80 text-[11px] text-muted-foreground backdrop-blur shadow-sm"
		>
			<span className="block px-2.5 pt-[7px] pb-[5px] leading-none tabular-nums">{label}</span>
			{size.w > 0 ? (
				<svg width={size.w} height={size.h} className="absolute inset-0 overflow-visible text-primary" aria-hidden>
					<rect
						x={0.75}
						y={0.75}
						width={size.w - 1.5}
						height={size.h - 1.5}
						rx={(size.h - 1.5) / 2}
						fill="none"
						stroke="currentColor"
						strokeWidth={1.5}
						pathLength={1}
						strokeDasharray={1}
						strokeDashoffset={1 - progress}
						className="transition-[stroke-dashoffset] duration-150"
					/>
				</svg>
			) : null}
		</div>
	);
}
