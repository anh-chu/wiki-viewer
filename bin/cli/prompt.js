import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

// A prompt helper that survives piped (non-TTY) stdin. node:readline/promises
// closes the stream between awaited questions when input is piped, so we buffer
// every line via the 'line' event and hand them out one at a time instead.
export function makePrompter() {
	const rl = createInterface({ input: stdin, output: stdout });
	const queue = [];
	const waiters = [];
	let closed = false;

	rl.on("line", (line) => {
		if (waiters.length) waiters.shift()(line);
		else queue.push(line);
	});
	rl.on("close", () => {
		closed = true;
		while (waiters.length) waiters.shift()(null);
	});

	const nextLine = () =>
		new Promise((resolve) => {
			if (queue.length) resolve(queue.shift());
			else if (closed) resolve(null);
			else waiters.push(resolve);
		});

	const prompt = async (text) => {
		stdout.write(text);
		const line = await nextLine();
		return line == null ? "" : line;
	};

	return { prompt, close: () => rl.close() };
}
