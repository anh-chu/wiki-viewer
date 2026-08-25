/**
 * Pure crash-restart supervision state for persisted (pinned) node apps.
 *
 * This module owns only supervision accounting/state transitions. The app
 * runner owns processes, timers, and file watching, and reacts to returned
 * restart actions.
 */

/** Global crash-restart cap for MVP (a plain counter, not a rolling window). */
export const DEFAULT_CRASH_RESTART_CAP = 5;

export type SupervisionStatus = "running" | "restarting" | "error" | "stopped";

export interface SupervisionState {
	/** Number of unexpected crash exits counted against the cap. */
	crashCount: number;
	/** Number of source-file-change restarts (never counted against the cap). */
	fileWatchRestartCount: number;
	status: SupervisionStatus;
	/** Human-readable last error, set when the cap is exceeded. */
	lastError?: string;
}

export type SupervisionEvent =
	| { type: "started" }
	| { type: "crash"; detail?: string }
	| { type: "file-change" }
	| { type: "manual-restart" }
	| { type: "stop" };

export type SupervisionAction = "restart" | "none";

export interface SupervisionResult {
	state: SupervisionState;
	action: SupervisionAction;
}

export function initialSupervisionState(): SupervisionState {
	return { crashCount: 0, fileWatchRestartCount: 0, status: "stopped" };
}

function crashCapMessage(crashCount: number, cap: number): string {
	return `Auto-restart gave up after ${crashCount} crash restarts (cap ${cap}). Fix the app and restart manually.`;
}

/** Advance supervision state for one event without I/O or input mutation. */
export function reduceSupervision(
	state: SupervisionState,
	event: SupervisionEvent,
	cap: number = DEFAULT_CRASH_RESTART_CAP,
): SupervisionResult {
	switch (event.type) {
		case "started":
			return {
				state: { ...state, status: "running", crashCount: 0, lastError: undefined },
				action: "none",
			};
		case "manual-restart":
			return {
				state: { ...state, status: "restarting", crashCount: 0, lastError: undefined },
				action: "restart",
			};
		case "file-change":
			if (state.status === "error") {
				return {
					state: { ...state, fileWatchRestartCount: state.fileWatchRestartCount + 1 },
					action: "none",
				};
			}
			return {
				state: {
					...state,
					status: "restarting",
					fileWatchRestartCount: state.fileWatchRestartCount + 1,
				},
				action: "restart",
			};
		case "crash": {
			if (state.status === "error") return { state, action: "none" };
			const crashCount = state.crashCount + 1;
			if (crashCount > cap) {
				return {
					state: {
						...state,
						crashCount,
						status: "error",
						lastError: crashCapMessage(crashCount, cap),
					},
					action: "none",
				};
			}
			return { state: { ...state, crashCount, status: "restarting" }, action: "restart" };
		}
		case "stop":
			return { state: { ...state, status: "stopped" }, action: "none" };
	}
}
