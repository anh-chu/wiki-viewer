import type { SshAuthMethod } from "@/lib/sshfs";

export interface WorkspaceGit {
	remoteUrl: string;
	branch?: string;
	/** Secret-store handle for the PAT; must never leave the server. */
	tokenRef?: string;
	username?: string;
	lastPulledAt?: string;
	lastSha?: string;
	lastError?: string;
	/** Sparse-checkout cone path (e.g. "docs"). rootDir points inside cloneRoot. */
	subpath?: string;
	/** Absolute path of the clone root. rootDir may differ when subpath is set. */
	cloneRoot?: string;
}

export interface WorkspaceSsh {
	/** Full target as entered: [user@]host:/path. */
	target: string;
	host: string;
	user?: string;
	remotePath: string;
	port?: number;
	authMethod: SshAuthMethod;
	/** Private key path (authMethod="keyfile"). */
	keyPath?: string;
	/** Secret-store ref for the password (authMethod="password"). */
	secretRef?: string;
	/** Absolute mount point. Equals rootDir. */
	mountpoint: string;
	lastMountedAt?: string;
	lastError?: string;
}

export interface Workspace {
	/** "ws_" + 6 random url-safe bytes. Stable, used in ?ws= query param. */
	id: string;
	/** Display label. Defaults to path.basename(rootDir). */
	name: string;
	/** Absolute, path.resolve'd rootDir. */
	rootDir: string;
	createdAt: string;
	lastOpenedAt?: string;
	pinnedPaths?: string[];
	/** User id of admin who created this workspace. */
	createdBy?: string;
	/**
	 * Explicit access list. Empty / undefined = any signed-in user may access.
	 * Admin users always have access regardless of this list.
	 */
	allowedUserIds?: string[];
	/** True for read-only workspaces (git-backed, sshfs read-only). Blocks mutations. */
	readOnly?: boolean;
	git?: WorkspaceGit;
	ssh?: WorkspaceSsh;
	/**
	 * True for a request-scoped root supplied by an embedding host (?root=).
	 * NEVER persisted, never in the registry, never shown in the switcher.
	 */
	ephemeral?: boolean;
}

/** Workspace record as persisted in ~/.wiki-viewer/config.json. */
export type PersistedWorkspace = Omit<Workspace, "ephemeral">;
