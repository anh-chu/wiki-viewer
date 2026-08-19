export interface LiveEngineClientOptions {
	port: number;
	token: string;
	/** Injectable fetch implementation for route-level and unit tests. */
	fetch?: typeof fetch;
	host?: string;
}

export interface LiveEngineHealth {
	status: string;
	port?: number;
	mode?: string;
	[key: string]: unknown;
}

export interface LiveEngineStatus {
	[key: string]: unknown;
}

export interface LivePollOptions {
	timeoutMs?: number;
	leaseMs?: number;
	types?: string[];
	signal?: AbortSignal;
}

export interface LivePollEvent {
	type?: string;
	[key: string]: unknown;
}

export class LiveEngineHttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "LiveEngineHttpError";
		this.status = status;
	}
}

/** Typed, token-scoped HTTP client for one Impeccable helper server. */
export class LiveEngineClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly requestFetch: typeof fetch;

	constructor(options: LiveEngineClientOptions) {
		if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
			throw new Error("Invalid live engine port");
		}
		if (!options.token) throw new Error("Missing live engine token");
		this.baseUrl = `http://${options.host ?? "127.0.0.1"}:${options.port}`;
		this.token = options.token;
		this.requestFetch = options.fetch ?? fetch;
	}

	private url(endpoint: string, params: Record<string, string> = {}): string {
		const url = new URL(endpoint, `${this.baseUrl}/`);
		url.searchParams.set("token", this.token);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
		return url.toString();
	}

	private async json<T>(response: Response): Promise<T> {
		if (!response.ok) {
			let detail = `Live engine request failed (${response.status})`;
			try {
				const body = (await response.json()) as { error?: unknown };
				if (typeof body.error === "string") detail = body.error;
			} catch {
				/* preserve the status-only error */
			}
			throw new LiveEngineHttpError(response.status, detail);
		}
		return (await response.json()) as T;
	}

	async health(signal?: AbortSignal): Promise<LiveEngineHealth> {
		const response = await this.requestFetch(this.url("/health"), { signal });
		return this.json<LiveEngineHealth>(response);
	}

	async poll(options: LivePollOptions = {}): Promise<LivePollEvent> {
		const params: Record<string, string> = {};
		if (options.timeoutMs !== undefined) params.timeout = String(options.timeoutMs);
		if (options.leaseMs !== undefined) params.leaseMs = String(options.leaseMs);
		if (options.types?.length) params.types = options.types.join(",");
		const response = await this.requestFetch(this.url("/poll", params), {
			signal: options.signal,
		});
		return this.json<LivePollEvent>(response);
	}

	/** Submit an agent reply. Token is included in the body for engine versions that require it there. */
	async reply<T extends Record<string, unknown>>(body: T, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const response = await this.requestFetch(this.url("/poll"), {
			method: "POST",
			signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...body, token: this.token }),
		});
		return this.json<Record<string, unknown>>(response);
	}

	async status(signal?: AbortSignal): Promise<LiveEngineStatus> {
		const response = await this.requestFetch(this.url("/status"), { signal });
		return this.json<LiveEngineStatus>(response);
	}

	async stop(signal?: AbortSignal): Promise<void> {
		const response = await this.requestFetch(this.url("/stop"), { signal });
		if (!response.ok) await this.json<unknown>(response);
	}
}

export function createLiveEngineClient(options: LiveEngineClientOptions): LiveEngineClient {
	return new LiveEngineClient(options);
}
