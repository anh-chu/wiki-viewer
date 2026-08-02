"use client";

import { useCallback, useEffect, useState } from "react";

import { wsFetch } from "@/lib/workspace-client";
import { showError } from "@/lib/toast";
import type { OpenFile } from "@/types/wiki";

export interface HistoryCommit {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	date: string;
}

export interface GitFileInfo {
	sha: string;
	author: string;
	date: string;
}

export function useGitHistory(openFile: OpenFile | null) {
	const [gitFileInfo, setGitFileInfo] = useState<GitFileInfo | null>(null);
	const [showHistory, setShowHistory] = useState(false);
	const [historyCommits, setHistoryCommits] = useState<HistoryCommit[]>([]);
	const [historyLoading, setHistoryLoading] = useState(false);
	const [selectedDiffSha, setSelectedDiffSha] = useState<string | null>(null);
	const [diffContent, setDiffContent] = useState<string | null>(null);
	const [diffLoading, setDiffLoading] = useState(false);

	const openPath = openFile?.path;

	useEffect(() => {
		setShowHistory(false);
		setHistoryCommits([]);
		setSelectedDiffSha(null);
		setDiffContent(null);
	}, [openPath]);

	useEffect(() => {
		if (!openPath) {
			setGitFileInfo(null);
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const res = await wsFetch(
						`/api/wiki/git-file-info?path=${encodeURIComponent(openPath)}`,
					);
					if (cancelled) return;
					if (!res.ok) {
						setGitFileInfo(null);
						return;
					}
					const d: { info: GitFileInfo | null } = await res.json();
					if (!cancelled) setGitFileInfo(d.info);
				} catch {
					if (!cancelled) setGitFileInfo(null);
				}
			})();
		}, 200);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [openPath]);

	const loadHistory = useCallback(async () => {
		if (!openFile) return;
		const path = openFile.path;
		setShowHistory(true);
		setHistoryLoading(true);
		setHistoryCommits([]);
		setSelectedDiffSha(null);
		setDiffContent(null);
		try {
			const res = await wsFetch(
				`/api/wiki/git-history?path=${encodeURIComponent(path)}`,
			);
			if (!res.ok) {
				showError("Could not load history");
				return;
			}
			const d: { commits: HistoryCommit[] } = await res.json();
			if (openFile.path === path) setHistoryCommits(d.commits);
		} catch {
			showError("Could not load history");
		} finally {
			setHistoryLoading(false);
		}
	}, [openFile]);

	const selectDiff = useCallback(
		async (sha: string) => {
			if (!openFile) return;
			if (selectedDiffSha === sha) {
				setSelectedDiffSha(null);
				setDiffContent(null);
				return;
			}
			const path = openFile.path;
			const targetSha = sha;
			setSelectedDiffSha(sha);
			setDiffLoading(true);
			setDiffContent(null);
			try {
				const res = await wsFetch(
					`/api/wiki/git-diff?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(sha)}`,
				);
				if (!res.ok) {
					showError("Could not load diff");
					return;
				}
				const d: { diff: string } = await res.json();
				if (openFile.path === path && selectedDiffSha === targetSha)
					setDiffContent(d.diff);
			} catch {
				showError("Could not load diff");
			} finally {
				setDiffLoading(false);
			}
		},
		[openFile, selectedDiffSha],
	);

	return {
		gitFileInfo,
		showHistory,
		setShowHistory,
		historyLoading,
		historyCommits,
		selectedDiffSha,
		setSelectedDiffSha,
		loadHistory,
		diffContent,
		diffLoading,
		selectDiff,
	};
}
