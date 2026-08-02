/**
 * better-sqlite3-compatible wrapper around node:sqlite DatabaseSync.
 *
 * Why this exists:
 * - better-sqlite3 ships a native .node binary that is locked to the publisher's
 *   Node ABI. The package publishes .next/standalone including node_modules, so
 *   that binary ends up in the tarball and breaks on different Node versions.
 * - node:sqlite (stable since Node 22.5.0) is built in, so no native binary is
 *   bundled and this bug class is eliminated.
 *
 * Compatibility target:
 * - Kysely's SqliteDialect driver expects:
 *     db.prepare(sql), db.close()
 *     stmt.reader
 *     stmt.all(parameters), stmt.run(parameters), stmt.iterate(parameters)
 *     where parameters is an array.
 * - Better Auth passes this wrapper/db into Kysely via SqliteDialect.
 *
 * node:sqlite differences handled here:
 * - StatementSync has no .reader property; use columns().length > 0.
 * - StatementSync methods reject a raw array as params ("Unknown named parameter '0'");
 *   they must be spread, so we accept either an array or rest args and expand.
 * - run() already returns { changes, lastInsertRowid }.
 * - DatabaseSync has no .pragma(); execute PRAGMA ... via exec().
 */
import { DatabaseSync, StatementSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

// node:sqlite's SQLInputValue is null | number | bigint | string | ArrayBufferView.
// boolean is not included. Use `as SQLInputValue[]` locally when spreading.
export type SqliteParam = string | number | boolean | null;

function normalizeParams(args: unknown[]): SqliteParam[] {
	// Accept either an array as the sole argument, or varargs.
	if (args.length === 1 && Array.isArray(args[0])) {
		return args[0] as SqliteParam[];
	}
	return args as SqliteParam[];
}

export class Statement {
	private readonly stmt: StatementSync;

	constructor(stmt: StatementSync) {
		this.stmt = stmt;
	}

	get reader(): boolean {
		return this.stmt.columns().length > 0;
	}

	all(...args: unknown[]): unknown[] {
		const params = normalizeParams(args);
		return this.stmt.all(...(params as SQLInputValue[])) as unknown[];
	}

	get(...args: unknown[]): unknown {
		const params = normalizeParams(args);
		return this.stmt.get(...(params as SQLInputValue[]));
	}

	run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
		const params = normalizeParams(args);
		const result = this.stmt.run(...(params as SQLInputValue[]));
		return {
			changes: Number(result.changes),
			lastInsertRowid: Number(result.lastInsertRowid),
		};
	}

	iterate(...args: unknown[]): IterableIterator<unknown> {
		const params = normalizeParams(args);
		return this.stmt.iterate(...(params as SQLInputValue[])) as IterableIterator<unknown>;
	}
}

export default class Database {
	private readonly db: DatabaseSync;

	constructor(filename: string) {
		this.db = new DatabaseSync(filename);
		// Match src/lib/auth/server.ts: WAL lets readers and a writer coexist, and a
		// busy_timeout makes a transient writer wait instead of failing immediately
		// with SQLITE_BUSY when another connection to the same file holds the lock
		// (e.g. concurrent Next.js build workers each importing a route module
		// that opens this database).
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec("PRAGMA journal_mode = WAL");
	}

	prepare(sql: string): Statement {
		return new Statement(this.db.prepare(sql));
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	close(): void {
		this.db.close();
	}

	pragma(str: string): void {
		this.db.exec(`PRAGMA ${str}`);
	}
}
