// Regression tests for the browser's high-frequency controller polling.
// Runs with Node; the game's disc image, WebAssembly and a browser aren't needed.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "rta-web.js"), "utf8");
function section(from, through) {
	const a = source.indexOf(from), b = source.indexOf(through, a + from.length);
	assert.ok(a >= 0 && b > a, "source code markers must exist");
	return source.slice(a, b);
}
const padCode = section("function activePad() {", "// nothing inside 15 %");
function pickPad(pads, preferredIndex) {
	const context = {
		navigator: { getGamepads: () => pads }, padInUse: preferredIndex,
		padName: pads.find((p) => p && p.index === preferredIndex)?.id || "",
		padBusy: (p) => p.buttons.some((b) => b.pressed),
		padMaps: {}, running: false, notice: () => {}, note: () => {},
		$: () => ({ hidden: true }), showBindings: () => {}, shortPad: (x) => x,
	};
	vm.createContext(context);
	vm.runInContext(padCode, context);
	return vm.runInContext("activePad()", context);
}
const pad = (index, pressed, connected = true) => ({
	index, id: "controller-" + index, connected, buttons: [{ pressed }],
});

test("active preferred controller keeps priority while pressed", () => {
	const a = pad(0, true), b = pad(1, true);
	assert.equal(pickPad([a, b], 1), b);
});
test("active idle controller yields to another controller with a pressed button", () => {
	const a = pad(0, true), b = pad(1, false);
	assert.equal(pickPad([a, b], 1), a);
});
test("idle preferred controller remains selected with no other press", () => {
	const a = pad(0, false), b = pad(1, false);
	assert.equal(pickPad([a, b], 1), b);
});
test("without any selected controller an unpressed controller is not assigned", () => {
	assert.equal(pickPad([pad(0, false), null, pad(2, false)], -1), null);
});
test("disconnected controllers are ignored", () => {
	assert.equal(pickPad([pad(0, true, false)], -1), null);
});
test("pollInput avoids near-duplicate rAF/timer polls without missing the next 8ms poll", () => {
	const input = section("let lastInputPoll = -Infinity;", "\n\trequestAnimationFrame(frame);\n\tsetInterval(pollInput");
	let time = 0, calls = 0;
	const context = { performance: { now: () => time }, readInput: () => { calls++; },
		requestAnimationFrame: () => {} };
	vm.createContext(context);
	vm.runInContext(input, context);
	vm.runInContext("pollInput()", context);
	time = 3;
	vm.runInContext("pollInput()", context);
	time = 8;
	vm.runInContext("pollInput()", context);
	time = 15;
	vm.runInContext("pollInput()", context);
	assert.equal(calls, 3);
});
