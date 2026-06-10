"use client";

import { Loader2 } from "lucide-react";
import { wsFetch } from "@/lib/workspace-client";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { OfficeChrome } from "./office-chrome";

interface Props {
	path: string;
	title: string;
}

interface Sheet {
	name: string;
	// Built lazily on first view; sheet_to_html over a huge sheet freezes the tab.
	html: string | null;
	rows: number; // total rows, for the truncation banner
	truncated: boolean;
}

// Sheets longer than this are clamped before conversion to cap DOM size.
const MAX_ROWS = 2000;

export function XlsxViewer({ path, title }: Props) {
	const [sheets, setSheets] = useState<Sheet[] | null>(null);
	const [active, setActive] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const wbRef = useRef<{
		wb: import("xlsx").WorkBook;
		toHtml: (ws: import("xlsx").WorkSheet) => {
			html: string;
			rows: number;
			truncated: boolean;
		};
	} | null>(null);

	// Build the active sheet's HTML the first time it is viewed.
	useEffect(() => {
		if (!sheets || !wbRef.current) return;
		const s = sheets[active];
		if (!s || s.html !== null) return;
		const { wb, toHtml } = wbRef.current;
		const r = toHtml(wb.Sheets[s.name]);
		setSheets((prev) => {
			if (!prev) return prev;
			const next = [...prev];
			next[active] = {
				...next[active],
				html: r.html,
				rows: r.rows,
				truncated: r.truncated,
			};
			return next;
		});
	}, [sheets, active]);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		setSheets(null);
		(async () => {
			try {
				const [XLSX, res] = await Promise.all([
					import("xlsx"),
					wsFetch(`/api/assets/${path}`),
				]);
				if (cancelled) return;
				if (!res.ok) throw new Error(`Failed to load file (${res.status})`);
				const buf = await res.arrayBuffer();
				if (cancelled) return;
				const wb = XLSX.read(buf, {
					type: "array",
					cellDates: true,
					cellStyles: true,
				});
				// Convert one worksheet to HTML, clamping its row range to MAX_ROWS.
				// Returns the HTML plus whether it was truncated and the true row
				// count. Kept here so it closes over the dynamically-imported XLSX.
				// sheet_to_html has no range option; it honors the sheet's own !ref.
				// For oversized sheets we shrink a copied !ref so only MAX_ROWS emit.
				const toHtml = (ws: import("xlsx").WorkSheet) => {
					const ref = ws["!ref"];
					const range = ref ? XLSX.utils.decode_range(ref) : null;
					const totalRows = range ? range.e.r - range.s.r + 1 : 0;
					if (!range || totalRows <= MAX_ROWS) {
						return {
							html: XLSX.utils.sheet_to_html(ws, { editable: false }),
							rows: totalRows,
							truncated: false,
						};
					}
					const clampedWs = {
						...ws,
						"!ref": XLSX.utils.encode_range({
							s: range.s,
							e: { r: range.s.r + MAX_ROWS - 1, c: range.e.c },
						}),
					};
					return {
						html: XLSX.utils.sheet_to_html(clampedWs, { editable: false }),
						rows: totalRows,
						truncated: true,
					};
				};
				if (cancelled) return;
				// Sheets render lazily via the active-sheet effect, so start them empty.
				wbRef.current = { wb, toHtml };
				setSheets(
					wb.SheetNames.map((name) => ({
						name,
						html: null,
						rows: 0,
						truncated: false,
					})),
				);
				setActive(0);
				setLoading(false);
			} catch (err) {
				if (!cancelled) {
					setError(
						err instanceof Error ? err.message : "Failed to parse spreadsheet",
					);
					setLoading(false);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [path]);

	const current = useMemo(() => sheets?.[active] ?? null, [sheets, active]);

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			<OfficeChrome path={path} title={title} extLabel="XLSX" />
			{sheets && sheets.length > 1 && (
				<div className="flex items-center gap-0.5 border-b border-border bg-muted/40 px-2 overflow-x-auto scrollbar-none">
					{sheets.map((s, i) => (
						<button
							key={s.name + i}
							type="button"
							onClick={() => setActive(i)}
							className={cn(
								"px-3 py-1.5 text-[12px] rounded-t whitespace-nowrap transition-colors",
								i === active
									? "bg-background text-foreground font-medium border-t border-x border-border -mb-px"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{s.name}
						</button>
					))}
				</div>
			)}
			<div className="flex-1 overflow-auto">
				{loading && !error && (
					<div className="h-full flex items-center justify-center text-muted-foreground">
						<Loader2 className="h-5 w-5 animate-spin mr-2" />
						Parsing spreadsheet…
					</div>
				)}
				{error && (
					<div className="h-full flex items-center justify-center">
						<div className="text-center space-y-2">
							<p className="text-sm text-destructive">{error}</p>
							<p className="text-xs text-muted-foreground">
								Try downloading the file and opening it externally.
							</p>
						</div>
					</div>
				)}
				{current?.truncated && (
					<div className="px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400 border-b border-border">
						Large sheet ({current.rows.toLocaleString()} rows). Showing first{" "}
						{MAX_ROWS.toLocaleString()} for performance. Download the file to
						see everything.
					</div>
				)}
				{current?.html != null && (
					<div
						className="xlsx-sheet p-3 text-[12px]"
						dangerouslySetInnerHTML={{ __html: current.html }}
					/>
				)}
			</div>
		</div>
	);
}
