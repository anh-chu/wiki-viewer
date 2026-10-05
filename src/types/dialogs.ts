/**
 * Workbench dialog state.
 *
 * Shared by the page shell and the panes it renders so the three declarations
 * cannot drift apart.
 */
export interface WorkbenchDialogs {
	settingsOpen: boolean;
	shareDialogOpen: boolean;
	/**
	 * What the share dialog publishes. `null` falls back to the open file, which
	 * is how the viewer toolbar opens the dialog.
	 */
	shareTarget: { path: string; type: "file" | "dir" } | null;
}
