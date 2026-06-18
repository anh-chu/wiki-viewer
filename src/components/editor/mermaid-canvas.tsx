"use client";

import { Maximize, Minimize2, ZoomIn, ZoomOut } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;

interface StageProps {
	svg: string;
	className?: string;
	allowPlainWheel?: boolean;
	onExpand?: () => void;
	onClose?: () => void;
}

function Stage({ svg, className, allowPlainWheel, onExpand, onClose }: StageProps) {
	const [zoom, setZoom] = useState(1);
	const [pan, setPan] = useState({ x: 0, y: 0 });
	const [isPanning, setIsPanning] = useState(false);
	const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
	const viewportRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const fitRef = useRef(1);

	// Scale the diagram to fully fit the viewport on render (never upscale past 1x),
	// so nothing is clipped in the default view. Reset returns to this fit.
	useLayoutEffect(() => {
		const vp = viewportRef.current;
		const svgEl = contentRef.current?.querySelector("svg");
		if (!vp || !svgEl) return;
		const vb = svgEl.viewBox?.baseVal;
		const rect = svgEl.getBoundingClientRect();
		const natW = vb?.width || rect.width;
		const natH = vb?.height || rect.height;
		if (!natW || !natH) return;
		const pad = 32; // p-4 on the content wrapper
		const fit = Math.min(
			1,
			(vp.clientWidth - pad) / natW,
			(vp.clientHeight - pad) / natH,
		);
		fitRef.current = fit > 0 ? fit : 1;
		setZoom(fitRef.current);
		setPan({ x: 0, y: 0 });
	}, [svg]);

	const zoomIn = () => setZoom((z) => Math.min(z + ZOOM_STEP, ZOOM_MAX));
	const zoomOut = () => setZoom((z) => Math.max(z - ZOOM_STEP, ZOOM_MIN));
	const reset = () => {
		setZoom(fitRef.current);
		setPan({ x: 0, y: 0 });
	};

	const handleWheel = useCallback(
		(e: React.WheelEvent) => {
			if (!(allowPlainWheel || e.ctrlKey || e.metaKey)) return;
			e.preventDefault();
			const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
			setZoom((z) => Math.min(Math.max(z + delta, ZOOM_MIN), ZOOM_MAX));
		},
		[allowPlainWheel],
	);

	const handlePointerDown = useCallback(
		(e: React.PointerEvent) => {
			if (e.button !== 0) return;
			setIsPanning(true);
			panStart.current = {
				x: e.clientX,
				y: e.clientY,
				panX: pan.x,
				panY: pan.y,
			};
			(e.target as HTMLElement).setPointerCapture(e.pointerId);
		},
		[pan],
	);

	const handlePointerMove = useCallback(
		(e: React.PointerEvent) => {
			if (!isPanning) return;
			setPan({
				x: panStart.current.panX + (e.clientX - panStart.current.x),
				y: panStart.current.panY + (e.clientY - panStart.current.y),
			});
		},
		[isPanning],
	);

	const handlePointerUp = useCallback(() => setIsPanning(false), []);

	return (
		<div
			ref={viewportRef}
			className={`relative overflow-hidden ${className ?? ""}`}
			style={{ cursor: isPanning ? "grabbing" : "grab" }}
			onWheel={handleWheel}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
		>
			<div
				ref={contentRef}
				className="flex items-center justify-center w-full h-full min-h-full p-4 [&_svg]:!max-w-none origin-center select-none"
				style={{
					transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
				}}
				// biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid SVG, securityLevel loose
				dangerouslySetInnerHTML={{ __html: svg }}
			/>
			<div
				className="absolute top-2 right-2 flex items-center gap-0.5 rounded-md border border-border bg-card/90 backdrop-blur px-1 py-0.5 shadow-sm"
				contentEditable={false}
			>
				<Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={zoomOut} title="Zoom out">
					<ZoomOut className="h-3.5 w-3.5" />
				</Button>
				<button
					type="button"
					onClick={reset}
					title="Reset view"
					className="text-[11px] text-muted-foreground tabular-nums w-9 text-center select-none hover:text-foreground"
				>
					{Math.round(zoom * 100)}%
				</button>
				<Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={zoomIn} title="Zoom in">
					<ZoomIn className="h-3.5 w-3.5" />
				</Button>
				{onExpand && (
					<Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onExpand} title="Pop out">
						<Maximize className="h-3.5 w-3.5" />
					</Button>
				)}
				{onClose && (
					<Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose} title="Close">
						<Minimize2 className="h-3.5 w-3.5" />
					</Button>
				)}
			</div>
		</div>
	);
}

export function MermaidCanvas({ svg, className }: { svg: string; className?: string }) {
	const [fullscreen, setFullscreen] = useState(false);
	useEffect(() => {
		if (!fullscreen) return;
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [fullscreen]);
	return (
		<>
			<Stage svg={svg} className={className} onExpand={() => setFullscreen(true)} />
			{fullscreen &&
				typeof document !== "undefined" &&
				createPortal(
					<div className="fixed inset-0 z-50 bg-background/95 backdrop-blur">
						<Stage
							svg={svg}
							className="w-full h-full"
							allowPlainWheel
							onClose={() => setFullscreen(false)}
						/>
					</div>,
					document.body,
				)}
		</>
	);
}
