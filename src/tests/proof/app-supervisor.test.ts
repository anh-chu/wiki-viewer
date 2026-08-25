import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CRASH_RESTART_CAP,
	initialSupervisionState,
	reduceSupervision,
	type SupervisionState,
} from "../../lib/app-supervisor.js";

function running(): SupervisionState {
	return reduceSupervision(initialSupervisionState(), { type: "started" }).state;
}

test("crash cap transitions to error", () => {
	let state = running();
	for (let i = 1; i <= DEFAULT_CRASH_RESTART_CAP; i++) {
		const result = reduceSupervision(state, { type: "crash" });
		state = result.state;
		assert.equal(state.crashCount, i);
		assert.equal(state.status, "restarting");
		assert.equal(result.action, "restart");
	}
	const over = reduceSupervision(state, { type: "crash" });
	assert.equal(over.state.status, "error");
	assert.equal(over.action, "none");
	assert.equal(over.state.crashCount, DEFAULT_CRASH_RESTART_CAP + 1);
	assert.match(over.state.lastError ?? "", /6/);
});

test("errored state ignores further crashes", () => {
	let state = running();
	for (let i = 0; i <= DEFAULT_CRASH_RESTART_CAP; i++) state = reduceSupervision(state, { type: "crash" }).state;
	const result = reduceSupervision(state, { type: "crash" });
	assert.equal(result.action, "none");
	assert.equal(result.state.crashCount, state.crashCount);
});

test("manual restart resets crash budget", () => {
	let state = running();
	for (let i = 0; i <= DEFAULT_CRASH_RESTART_CAP; i++) state = reduceSupervision(state, { type: "crash" }).state;
	const result = reduceSupervision(state, { type: "manual-restart" });
	assert.equal(result.state.crashCount, 0);
	assert.equal(result.state.lastError, undefined);
	assert.equal(result.state.status, "restarting");
	assert.equal(result.action, "restart");
});

test("file changes do not consume crash budget", () => {
	let state = running();
	for (let i = 1; i <= DEFAULT_CRASH_RESTART_CAP * 3; i++) {
		const result = reduceSupervision(state, { type: "file-change" });
		state = result.state;
		assert.equal(result.action, "restart");
		assert.equal(state.crashCount, 0);
		assert.equal(state.fileWatchRestartCount, i);
	}
});

test("file change does not resurrect errored app", () => {
	let state = running();
	for (let i = 0; i <= DEFAULT_CRASH_RESTART_CAP; i++) state = reduceSupervision(state, { type: "crash" }).state;
	const result = reduceSupervision(state, { type: "file-change" });
	assert.equal(result.action, "none");
	assert.equal(result.state.status, "error");
	assert.equal(result.state.crashCount, state.crashCount);
	assert.equal(result.state.fileWatchRestartCount, 1);
});
