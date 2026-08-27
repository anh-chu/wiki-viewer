"use client";

import { Ban, Code2, Eye, Loader2, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { Button } from "@/components/ui/button";
import { withWs, wsFetch } from "@/lib/workspace-client";

interface MdxViewerProps {
	path: string;
	title: string;
}

// React version must match the app's installed React so the sandboxed runtime
// behaves identically. Loaded cross-origin (esm.sh) into a null-origin iframe.
const REACT_VERSION = "19.2.5";
const IMPORT_MAP = {
	imports: {
		react: `https://esm.sh/react@${REACT_VERSION}`,
		"react-dom": `https://esm.sh/react-dom@${REACT_VERSION}?deps=react@${REACT_VERSION}`,
		"react-dom/client": `https://esm.sh/react-dom@${REACT_VERSION}/client?deps=react@${REACT_VERSION}`,
		"react/jsx-runtime": `https://esm.sh/react@${REACT_VERSION}/jsx-runtime`,
	},
};

/**
 * Compile MDX source to an ES module (browser-side, no execution).
 * JSX becomes `react/jsx-runtime` calls; YAML/TOML frontmatter is stripped.
 */
async function compileMdx(source: string): Promise<string> {
	const [{ compile }, remarkGfm, remarkFrontmatter] = await Promise.all([
		import("@mdx-js/mdx"),
		import("remark-gfm").then((m) => m.default),
		import("remark-frontmatter").then((m) => m.default),
	]);
	const file = await compile(source, {
		outputFormat: "program",
		development: false,
		remarkPlugins: [remarkGfm, [remarkFrontmatter, ["yaml", "toml"]]],
	});
	return String(file);
}

function buildSrcDoc(compiled: string): string {
	// The compiled module already imports jsx-runtime and `export default`s
	// MDXContent. We prepend the React runtime imports and append a bootstrap
	// that renders it, wrapped in an error boundary so component failures show
	// inline instead of blanking the frame.
	return `<!doctype html><html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://esm.sh; style-src 'unsafe-inline'; img-src * data:; font-src * data:; connect-src https://esm.sh; frame-src *" />
<script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px; font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #1a1a1a; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e5e5e5; background: #1a1a1a; } }
  #root { max-width: 860px; margin: 0 auto; }
  pre { overflow: auto; padding: 12px; background: rgba(127,127,127,0.12); border-radius: 6px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
  table { border-collapse: collapse; } th, td { border: 1px solid rgba(127,127,127,0.35); padding: 6px 10px; }
  img { max-width: 100%; }
  .mdx-error { color: #dc2626; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 13px; }
</style>
</head><body><div id="root"></div>
<script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
function reportError(e) {
  const root = document.getElementById('root');
  if (root) root.innerHTML = '<pre class="mdx-error">' + String(e && e.stack ? e.stack : e) + '</pre>';
}
window.addEventListener('error', (ev) => reportError(ev.error || ev.message));
window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason));
class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return React.createElement('pre', { className: 'mdx-error' }, String(this.state.error && this.state.error.stack || this.state.error));
    return this.props.children;
  }
}
try {
${compiled}
  createRoot(document.getElementById('root')).render(
    React.createElement(ErrorBoundary, null, React.createElement(MDXContent))
  );
} catch (e) { reportError(e); }
</script>
</body></html>`;
}

export function MdxViewer({ path, title }: MdxViewerProps) {
	const [source, setSource] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [scriptsEnabled, setScriptsEnabled] = useState(false);
	const [showSource, setShowSource] = useState(false);
	const [compiled, setCompiled] = useState<string | null>(null);
	const [compileError, setCompileError] = useState<string | null>(null);
	const [compiling, setCompiling] = useState(false);
	const assetUrl = withWs(`/api/assets/${path}`);
	const compileSeq = useRef(0);

	const fetchSource = useCallback(async () => {
		setLoading(true);
		setSource(null);
		try {
			const res = await wsFetch(assetUrl);
			if (res.ok) setSource(await res.text());
		} catch {
			/* ignore */
		} finally {
			setLoading(false);
		}
	}, [assetUrl]);

	useEffect(() => {
		void fetchSource();
	}, [fetchSource]);

	// Compile only once the user has opted into script execution.
	useEffect(() => {
		if (!scriptsEnabled || source === null) return;
		const seq = ++compileSeq.current;
		setCompiling(true);
		setCompileError(null);
		compileMdx(source)
			.then((code) => {
				if (seq !== compileSeq.current) return;
				setCompiled(code);
			})
			.catch((e: unknown) => {
				if (seq !== compileSeq.current) return;
				setCompiled(null);
				setCompileError(e instanceof Error ? e.message : String(e));
			})
			.finally(() => {
				if (seq === compileSeq.current) setCompiling(false);
			});
	}, [scriptsEnabled, source]);

	const srcDoc = useMemo(
		() => (compiled ? buildSrcDoc(compiled) : null),
		[compiled],
	);

	return (
		<div className="flex-1 flex flex-col overflow-hidden min-h-0">
			<ViewerToolbar path={path} badge="MDX">
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 text-xs"
					onClick={() => setShowSource((s) => !s)}
					title={showSource ? "Show preview" : "Show source"}
				>
					{showSource ? (
						<>
							<Eye className="h-3.5 w-3.5" />
							Preview
						</>
					) : (
						<>
							<Code2 className="h-3.5 w-3.5" />
							Source
						</>
					)}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 text-xs"
					onClick={() => setScriptsEnabled((s) => !s)}
					title={
						scriptsEnabled
							? "Disable scripts"
							: "Enable scripts to render this MDX (executes its JavaScript)"
					}
				>
					{scriptsEnabled ? (
						<>
							<Ban className="h-3.5 w-3.5" />
							Disable scripts
						</>
					) : (
						<>
							<Play className="h-3.5 w-3.5" />
							Enable scripts
						</>
					)}
				</Button>
			</ViewerToolbar>

			<div className="relative flex-1 flex overflow-hidden min-h-0">
				{loading ? (
					<div className="flex-1 flex justify-center py-8">
						<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
					</div>
				) : showSource ? (
					<pre className="flex-1 overflow-auto m-0 p-4 text-[13px] font-mono leading-relaxed whitespace-pre-wrap break-words">
						{source}
					</pre>
				) : !scriptsEnabled ? (
					<div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
						<p className="text-sm text-muted-foreground max-w-sm">
							MDX runs JavaScript to render. Enable scripts to execute and
							preview this document. Components load in a sandboxed frame with
							no access to your session.
						</p>
						<Button
							size="sm"
							variant="default"
							className="gap-1.5"
							onClick={() => setScriptsEnabled(true)}
						>
							<Play className="h-3.5 w-3.5" />
							Enable scripts &amp; render
						</Button>
					</div>
				) : compiling ? (
					<div className="flex-1 flex justify-center py-8">
						<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
					</div>
				) : compileError ? (
					<pre className="flex-1 overflow-auto m-0 p-4 text-[13px] font-mono leading-relaxed whitespace-pre-wrap break-words text-destructive">
						{compileError}
					</pre>
				) : srcDoc ? (
					<iframe
						key={srcDoc.length}
						srcDoc={srcDoc}
						className="flex-1 w-full border-0 bg-card"
						title={title}
						sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
					/>
				) : null}
			</div>
		</div>
	);
}
