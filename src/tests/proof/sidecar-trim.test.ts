import { test } from "node:test";
import assert from "node:assert/strict";
import { emitEvents, trimEvents } from "../../lib/proof/event-bus.js";
import { emptySidecar } from "../../lib/proof/sidecar.js";

test("trimEvents: keeps last 1000 events when no ack cursors", () => {
	const sc = emptySidecar("test.md");

	// Emit 2000 events
	for (let i = 0; i < 2000; i++) {
		emitEvents(sc, [{ type: "block.inserted", at: new Date().toISOString(), by: "ai:test", position: "end", refs: [`b${i}`] }]);
	}
	assert.equal(sc.events.length, 2000);
	assert.equal(sc.nextEventId, 2001); // starts at 1, increments to 2001 after 2000 events

	trimEvents(sc, 1000);

	assert.equal(sc.events.length, 1000);
	// Events retained should be the last 1000 (IDs 1001-2000)
	assert.equal(sc.events[0].id, 1001);
	assert.equal(sc.events[999].id, 2000);
});

test("trimEvents: retains events newer than oldest ack cursor even beyond trim window", () => {
	const sc = emptySidecar("test.md");

	// Emit 2000 events
	for (let i = 0; i < 2000; i++) {
		emitEvents(sc, [{ type: "block.inserted", at: new Date().toISOString(), by: "ai:test", position: "end", refs: [`b${i}`] }]);
	}

	// Agent acked up to event 200 (old cursor - before the trim window)
	sc.lastAck["ai:slow"] = 200;

	trimEvents(sc, 1000);

	// Events from IDs 201+ should be retained (because ack is at 200, events > 200 must be kept)
	// Plus the last 1000 (1000-1999). Combined: events with id > 200 OR index >= 1000.
	// Events 0-999 are candidates for trim. Events 0-200 have id <= 200, kept only if index >= 1000 (none).
	// Events 201-999 have id > 200, kept. Events 1000-1999 always kept.
	// So total retained: (999-201+1) + 1000 = 799 + 1000 = 1799
	assert.ok(sc.events.length > 1000, `expected >1000 events, got ${sc.events.length}`);
	// No event with id <= 200 should be present
	for (const ev of sc.events) {
		assert.ok(ev.id > 200, `Event id ${ev.id} should have been trimmed (ack at 200)`);
	}
});

test("trimEvents: no-op when events <= trim size", () => {
	const sc = emptySidecar("test.md");

	for (let i = 0; i < 500; i++) {
		emitEvents(sc, [{ type: "block.inserted", at: new Date().toISOString(), by: "ai:test", position: "end", refs: [`b${i}`] }]);
	}

	trimEvents(sc, 1000);
	assert.equal(sc.events.length, 500);
});
