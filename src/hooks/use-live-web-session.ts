"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { withWs, wsFetch } from "@/lib/workspace-client";

export interface LiveWebSession {
	port: number;
	token: string;
	scaffoldId: string;
}

export type LiveWebSessionState = "idle" | "starting" | "live" | "error";

type ParamValues = Record<string, string | number>;

interface SessionResponse {
	ok?: boolean;
	port?: unknown;
	token?: unknown;
	scaffoldId?: unknown;
}

interface StatusResponse {
	ok?: boolean;
	engineLive?: unknown;
}

export interface UseLiveWebSessionResult {
	session: LiveWebSession | null;
	state: LiveWebSessionState;
	error: string | null;
	start: (path: string) => Promise<void>;
	stop: () => Promise<void>;
	accept: (chosenVariantId: string, paramValues?: ParamValues) => Promise<void>;
	discard: () => Promise<void>;
}

function responseError(response: Response, fallback: string): Promise<Error> {
	return response
		.json()
		.then((body: unknown) => {
			if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
				return new Error(body.error);
			}
			return new Error(fallback);
		})
		.catch(() => new Error(fallback));
}

/** Owns one static-HTML live engine session for the current viewer. */
export function useLiveWebSession(): UseLiveWebSessionResult {
	const [session, setSession] = useState<LiveWebSession | null>(null);
	const [state, setState] = useState<LiveWebSessionState>("idle");
	const [error, setError] = useState<string | null>(null);
	const sessionRef = useRef<LiveWebSession | null>(null);
	const pathRef = useRef<string | null>(null);
	const operationRef = useRef(0);
	const stateRef = useRef(state);
	stateRef.current = state;
	const mountedRef = useRef(true);
	const stopRequestRef = useRef<Promise<void> | null>(null);

	const setCurrentSession = useCallback((next: LiveWebSession | null) => {
		sessionRef.current = next;
		setSession(next);
	}, []);

	const stop = useCallback(async (): Promise<void> => {
		if (stopRequestRef.current) return stopRequestRef.current;
		const path = pathRef.current;
		const hadSession =
			sessionRef.current !== null || stateRef.current === "starting" || stateRef.current === "live";
		operationRef.current += 1;
		setCurrentSession(null);
		if (mountedRef.current) {
			setState("idle");
			setError(null);
		}
		if (!path || !hadSession) return;

		const request = (async () => {
			try {
				const response = await wsFetch("/api/wiki/live-web/session", {
					method: "DELETE",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path }),
				});
				if (!response.ok) throw await responseError(response, "Could not stop live session.");
			} catch (cause) {
				if (mountedRef.current) {
					setState("error");
					setError(cause instanceof Error ? cause.message : "Could not stop live session.");
				}
			}
		})();
		stopRequestRef.current = request;
		try {
			await request;
		} finally {
			stopRequestRef.current = null;
		}
	}, [setCurrentSession]);

	const start = useCallback(
		async (path: string): Promise<void> => {
			const operation = ++operationRef.current;
			pathRef.current = path;
			setCurrentSession(null);
			setState("starting");
			setError(null);
			try {
				const response = await wsFetch("/api/wiki/live-web/session", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path }),
				});
				if (!response.ok) throw await responseError(response, "Could not start live session.");
				const body = (await response.json()) as SessionResponse;
				if (
					typeof body.port !== "number" ||
					!Number.isInteger(body.port) ||
					typeof body.token !== "string" ||
					!body.token ||
					typeof body.scaffoldId !== "string" ||
					!body.scaffoldId
				) {
					throw new Error("Invalid live session response.");
				}
				if (operation !== operationRef.current) return;
				setCurrentSession({ port: body.port, token: body.token, scaffoldId: body.scaffoldId });
				setState("live");
			} catch (cause) {
				if (operation !== operationRef.current || !mountedRef.current) return;
				setState("error");
				setError(cause instanceof Error ? cause.message : "Could not start live session.");
			}
		},
		[setCurrentSession],
	);

	const resolve = useCallback(
		async (action: "accept" | "discard", chosenVariantId?: string, paramValues?: ParamValues) => {
			const path = pathRef.current;
			if (!path) return;
			const operation = ++operationRef.current;
			try {
				const response = await wsFetch("/api/wiki/live-web/resolve", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						action,
						path,
						...(chosenVariantId ? { chosenVariantId } : {}),
						...(paramValues ? { paramValues } : {}),
					}),
				});
				if (!response.ok) {
					throw await responseError(
						response,
						action === "accept" ? "Could not accept live tweak." : "Could not discard live tweak.",
					);
				}
				if (operation !== operationRef.current) return;
				setCurrentSession(null);
				setState("idle");
				setError(null);
			} catch (cause) {
				if (!mountedRef.current || operation !== operationRef.current) return;
				setState("error");
				setError(cause instanceof Error ? cause.message : "Could not resolve live tweak.");
			}
		},
		[setCurrentSession],
	);

	const accept = useCallback(
		(chosenVariantId: string, paramValues?: ParamValues) =>
			resolve("accept", chosenVariantId, paramValues),
		[resolve],
	);
	const discard = useCallback(() => resolve("discard"), [resolve]);

	// Poll status while the browser is connected to the live engine.
	useEffect(() => {
		if (state !== "live" || !session) return;
		let alive = true;
		const poll = async () => {
			try {
				const path = pathRef.current;
				if (!path) return;
				const response = await wsFetch(
					`/api/wiki/live-web/status?path=${encodeURIComponent(path)}`,
				);
				if (!response.ok) throw await responseError(response, "Live session status failed.");
				const body = (await response.json()) as StatusResponse;
				if (body.engineLive !== true) throw new Error("Live session stopped unexpectedly.");
			} catch (cause) {
				if (!alive || !mountedRef.current) return;
				setState("error");
				setError(cause instanceof Error ? cause.message : "Live session status failed.");
			}
		};
		const timer = window.setInterval(() => void poll(), 2000);
		return () => {
			alive = false;
			window.clearInterval(timer);
		};
	}, [session, state]);

	// Best-effort teardown for navigation and component unmount.
	useEffect(() => {
		const onBeforeUnload = () => {
			const path = pathRef.current;
			const active = sessionRef.current !== null || stateRef.current === "starting" || stateRef.current === "live";
			if (!path || !active) return;
			void fetch(withWs("/api/wiki/live-web/session"), {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path }),
				keepalive: true,
			});
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, []);

	useEffect(() => {
		return () => {
			mountedRef.current = false;
			void stop();
		};
	}, [stop]);

	return { session, state, error, start, stop, accept, discard };
}
