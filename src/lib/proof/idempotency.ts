// Tiny in-memory LRU. Lives for process lifetime. Acceptable: idempotency
// guards retries within seconds, not days.
const MAX = 1000;
const TTL_MS = 5 * 60 * 1000;

interface Entry {
	payloadHash: string;
	status: number;
	body: string;
	expiresAt: number;
}

const store = new Map<string, Entry>();

export const idempotency = {
	get(key: string): Entry | null {
		const e = store.get(key);
		if (!e) return null;
		if (e.expiresAt < Date.now()) {
			store.delete(key);
			return null;
		}
		return e;
	},
	set(key: string, value: Omit<Entry, "expiresAt">): void {
		if (store.size >= MAX) {
			const first = store.keys().next().value;
			if (first !== undefined) store.delete(first);
		}
		store.set(key, { ...value, expiresAt: Date.now() + TTL_MS });
	},
};
