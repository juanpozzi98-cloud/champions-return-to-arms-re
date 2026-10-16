// play-web: the page's side of the browser build (see ../README.md).
//
// What a person does: opens the page, picks the disc image (it is checked, remembered
// where the browser can do that, and read in place), plays with the keyboard or a
// controller. Picture factor and sound are in the menu; saved games and settings stay in
// this browser's storage.
//
// Address parameters (all optional; the ones marked DEV are for tests on the developer's
// own computer and do nothing on a page that is merely opened):
//   res=N          resolution factor for this visit (1..8; otherwise the menu's setting, 2 at first)
//   patches=0      do not apply the patch set          display=0   no display patches
//   sections=*     apply every section of the patch file instead of the suggested ones
//   sound=0        no sound
//   card=0         DEV: an empty memory card that is not kept (tests that must start the same way every time)
//   canvas=LINES   DEV: the canvas's height in pixels (default: what the page shows, at most 896)
//   gl=main        DEV: GL context on the page's main thread, as Play! itself does it
//   limit=0        DEV: the machine runs as fast as it can
//   disc=URL       DEV: boot the disc image at this URL of the same server (range requests)
//   auto=title|hub DEV: press the way to the title screen or into the first level, measure, report
//   auto=trace     DEV: into the first level, then the player's position frame by frame (standing, then walking)
//   report=1       DEV: POST the speed figures to /report of the same server once a second
//   shot=NAME.png  DEV: with auto=hub, POST one picture of the canvas in the level to /shot/NAME.png
//   glprofile=1    DEV: with auto=hub, every WebGL call of the video thread counted for 5 s (slows it down)
//   pause=0        DEV: the game is not paused when the page is hidden (auto= implies it: tests run unwatched)
//   discread=page  DEV: a picked file is read through the page's main thread, as in a browser without range requests on it
//   touch=1        the on-screen pad is shown at once
//   title=TEXT     the page's title (tests: "AGENT TEST - browser build")
//   relay=ws://127.0.0.1:PORT/relay   DEV: go online through a relay on this computer
//
// Online play is there when a file online.json lies beside the page:
//   { "relay": "relay", "signin": "NAME.pnach" }
// "relay" is the address of the relay's WebSocket (tools/play-web/relay), relative to the
// page or complete; "signin" names a patch file beside the page that takes the game past
// its sign-in step (a privately served page has one; it is not part of the repository).
// "mixed": false says that the relay carries browser players only (relay.py --pages-only):
// the page then says so instead of offering games with players of the Mac application.
import Play from "./Play.js";

const params = new URLSearchParams(location.search);
if(params.get("title")) document.title = params.get("title");

const GAME_EXECUTABLE = "SLUS_209.73";
const GAME_CRC = 0x4028A55F;

// bit numbers: PS2::CControllerInfo::BUTTON
const B = {
	lx: 0, ly: 1, rx: 2, ry: 3, up: 4, down: 5, left: 6, right: 7, select: 8, start: 9,
	square: 10, triangle: 11, circle: 12, cross: 13, l1: 14, l2: 15, l3: 16, r1: 17, r2: 18, r3: 19,
};
// What can be given a key or a controller button: the sixteen buttons and the four
// directions of each stick. [name, what the page calls it]
const CONTROLS = [
	["up", "D-pad ↑"], ["down", "D-pad ↓"], ["left", "D-pad ←"], ["right", "D-pad →"],
	["cross", "✕"], ["circle", "○"], ["square", "□"], ["triangle", "△"],
	["l1", "L1"], ["r1", "R1"], ["l2", "L2"], ["r2", "R2"], ["l3", "L3 (left stick pressed)"], ["r3", "R3 (right stick pressed)"],
	["start", "Start"], ["select", "Select"],
	["ls-left", "Left stick ←"], ["ls-right", "Left stick →"], ["ls-up", "Left stick ↑"], ["ls-down", "Left stick ↓"],
	["rs-left", "Right stick ←"], ["rs-right", "Right stick →"], ["rs-up", "Right stick ↑"], ["rs-down", "Right stick ↓"],
];
// a stick's direction: [stick (0 left, 1 right), axis (0 x, 1 y), direction]
const STICKS = {
	"ls-left": [0, 0, -1], "ls-right": [0, 0, 1], "ls-up": [0, 1, -1], "ls-down": [0, 1, 1],
	"rs-left": [1, 0, -1], "rs-right": [1, 0, 1], "rs-up": [1, 1, -1], "rs-down": [1, 1, 1],
};
// Keys are named by their place on the keyboard (KeyboardEvent.code), not by the letter
// printed there: the layout is the same on a French, German or Dvorak keyboard.
const DEFAULT_KEYS = {
	up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
	triangle: "KeyI", square: "KeyJ", cross: "KeyK", circle: "KeyL",
	l1: "KeyQ", r1: "KeyE", l2: "Digit1", r2: "Digit3", l3: "KeyX", r3: "KeyC", start: "Enter", select: "Backspace",
	"ls-left": "KeyA", "ls-right": "KeyD", "ls-up": "KeyW", "ls-down": "KeyS",
	"rs-left": "KeyF", "rs-right": "KeyH", "rs-up": "KeyT", "rs-down": "KeyG",
};
// A controller: "b<n>" a button, "a<n>+" / "a<n>-" an axis pushed that way, "h<n>u|r|d|l" a
// direction of a hat switch that is reported as one axis. This is the Gamepad API's
// "standard" layout, which browsers give for the pads they know (button 17, a
// PlayStation pad's touchpad, is Select as well).
const DEFAULT_PAD = {
	cross: "b0", circle: "b1", square: "b2", triangle: "b3", l1: "b4", r1: "b5", l2: "b6", r2: "b7", select: "b8", start: "b9", l3: "b10", r3: "b11",
	up: "b12", down: "b13", left: "b14", right: "b15",
	"ls-left": "a0-", "ls-right": "a0+", "ls-up": "a1-", "ls-down": "a1+", "rs-left": "a2-", "rs-right": "a2+", "rs-up": "a3-", "rs-down": "a3+",
};

const G_IN_FRONTEND = 0x41b510, G_LEVEL_NAME = 0x41b721;

const $ = (id) => document.getElementById(id);
const statusElement = $("status");
const speedElement = $("speed");
const canvas = $("outputCanvas");
const factorElement = $("factor");
const log = [];
function note(text) {
	log.push(text);
	if(log.length > 400) log.shift();
	console.log(text);
}
function setStatus(text, bad = false) {
	statusElement.textContent = text;
	statusElement.classList.toggle("bad", bad);
	note("status: " + text);
}
// The bar under the status line: a fraction (0..1), "busy" (how far is not known), or null (gone).
function progress(state) {
	const bar = $("progress");
	bar.hidden = state === null;
	bar.classList.toggle("busy", state === "busy");
	bar.firstElementChild.style.width = typeof state === "number" ? Math.round(Math.max(0, Math.min(1, state)) * 100) + "%" : "";
}

// settings: this browser's storage for this site
function stored(key, fallback) {
	try { return localStorage.getItem("rta." + key) ?? fallback; } catch(e) { return fallback; }
}
function store(key, value) {
	try { localStorage.setItem("rta." + key, value); } catch(e) { /* private window */ }
}

const options = {
	factor: Math.max(1, Math.min(8, parseInt(params.get("res") || stored("factor", "2"), 10) || 2)),
	patches: params.get("patches") !== "0",
	display: params.get("display") !== "0",
	allSections: params.get("sections") === "*",
	sound: params.get("sound") !== "0",
	muted: stored("muted", "0") === "1",
	volume: Math.max(0, Math.min(100, parseInt(stored("volume", "100"), 10) || 0)),
	touch: params.get("touch") === "1" ? "on" : stored("touch", "auto"),
	// tests run unwatched, often with the window covered: they are not paused
	autoPause: params.get("pause") !== "0" && !params.get("auto") && params.get("report") !== "1",
	glMain: params.get("gl") === "main",
	limit: params.get("limit") !== "0",
	disc: params.get("disc"),
	auto: params.get("auto"),
	report: params.get("report") === "1",
};
factorElement.value = String(Math.min(4, options.factor));
factorElement.addEventListener("change", () => {
	options.factor = parseInt(factorElement.value, 10);
	store("factor", factorElement.value);
	// takes effect at once: the video handler makes its pictures anew at the new size
	if(module && module._rtaReady()) module._rtaSetFactor(options.factor);
	canvas.focus();
});

let module = null;
let shared = 0;           // index into HEAPU32 of the shared words
let running = false;
let audio = null;
const keysDown = new Set();
// the start-up check (index.html); without it (the script alone on another page) everything is taken to be there
const check = window.rtaCheck || { has: { discInPlace: true, audioWorklet: true, gamepads: true, database: true, locks: !!navigator.locks, filePicker: !!window.showOpenFilePicker }, missing: [], notes: [], browser: "this browser" };
let pausedBy = "";        // "": the game runs; "hidden": the page was not in front; "disc": the image cannot be read
let discFile = null;      // the picked file

// What the page has to tell while the game runs: a line over the lower edge of the
// picture, gone after a while or at a click (ms 0: it stays).
let noticeTimer = 0;
function notice(text, bad = false, ms = 9000) {
	const element = $("notice");
	element.textContent = text;
	element.classList.toggle("bad", bad);
	element.hidden = !text;
	clearTimeout(noticeTimer);
	if(text && ms) noticeTimer = setTimeout(() => { element.hidden = true; }, ms);
	if(text) note("notice: " + text);
}
$("notice").addEventListener("click", () => notice(""));
// Of the panels at the right (controls, settings) one is open at a time.
function panel(id, open) {
	for(const [other, its] of [["controls", "help"], ["settings", "settingsButton"]]) {
		const show = other === id ? (open ?? $(other).hidden) : false;
		$(other).hidden = !show;
		$(its).setAttribute("aria-expanded", String(show));
	}
	if($(id).hidden) canvas.focus();
	return !$(id).hidden;
}

// ---- the disc -----------------------------------------------------------------------
// A reader is { size, read(offset, length) -> Promise<Uint8Array> }.
function fileReader(file) {
	return { size: file.size, read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()) };
}
async function urlReader(url) {
	const head = await fetch(url, { method: "HEAD" });
	if(!head.ok) throw new Error("the disc image at " + url + " cannot be read (" + head.status + ")");
	const size = parseInt(head.headers.get("content-length"), 10);
	return {
		size,
		read: async (offset, length) => {
			const response = await fetch(url, { headers: { Range: "bytes=" + offset + "-" + (offset + length - 1) } });
			if(response.status !== 206) throw new Error("the server does not answer range requests (" + response.status + ")");
			return new Uint8Array(await response.arrayBuffer());
		},
	};
}

// Is this the disc the patches and this page are for? As Rta::CheckDisc of the desktop
// application: SYSTEM.CNF names SLUS_209.73, and the program's checksum (all its 32-bit
// words exclusive-ored, as PCSX2 names its patch files) is 4028A55F. Returns "" or the
// reason for refusing.
async function checkDisc(reader) {
	const SECTOR = 2048;
	if(reader.size < 64 * SECTOR) return "this file is not a disc image (it is far too small)";
	const volume = await reader.read(16 * SECTOR, SECTOR);
	if(String.fromCharCode(...volume.subarray(1, 6)) !== "CD001") {
		// what people pick instead: the image still packed, or in an emulator's own format
		const head = String.fromCharCode(...(await reader.read(0, 8)));
		const packed = head.startsWith("PK") ? "a zip archive" : head.startsWith("7z") ? "a 7-Zip archive" : head.startsWith("Rar!") ? "a RAR archive" : head.startsWith("\x1f\x8b") ? "a gzip file" :
			head.startsWith("MComprHD") ? "a CHD image" : head.startsWith("CISO") ? "a CSO image" : head.startsWith("ZISO") ? "a ZSO image" : "";
		if(packed) return "this file is " + packed + ", not a plain disc image: unpack or convert it to an .iso file first and choose that";
		return "this file is not a disc image a PlayStation 2 game comes on (no ISO 9660 volume in it)";
	}
	const view = new DataView(volume.buffer, volume.byteOffset);
	const rootSector = view.getUint32(156 + 2, true), rootSize = view.getUint32(156 + 10, true);
	const root = await reader.read(rootSector * SECTOR, Math.min(rootSize, 64 * SECTOR));
	const files = {};
	for(let offset = 0; offset < root.length;) {
		const length = root[offset];
		if(length === 0) { offset = (Math.floor(offset / SECTOR) + 1) * SECTOR; continue; }
		const entry = new DataView(root.buffer, root.byteOffset + offset, length);
		const nameLength = root[offset + 32];
		const name = String.fromCharCode(...root.subarray(offset + 33, offset + 33 + nameLength)).replace(/;1$/, "");
		files[name] = { sector: entry.getUint32(2, true), size: entry.getUint32(10, true) };
		offset += length;
	}
	if(!files["SYSTEM.CNF"]) return "this is not a PlayStation 2 game disc (no SYSTEM.CNF)";
	const config = String.fromCharCode(...await reader.read(files["SYSTEM.CNF"].sector * SECTOR, Math.min(files["SYSTEM.CNF"].size, 4096)));
	const boot = /BOOT2\s*=\s*cdrom0:\\?([^;\s]+)/i.exec(config);
	if(!boot) return "this is not a PlayStation 2 game disc (SYSTEM.CNF names no program)";
	if(boot[1].toUpperCase() !== GAME_EXECUTABLE) return "this is the disc of another game, or of another country's release (it names " + boot[1] + "); wanted is Champions: Return to Arms, US release, " + GAME_EXECUTABLE;
	const program = files[GAME_EXECUTABLE];
	if(!program) return "the disc image is damaged: its program " + GAME_EXECUTABLE + " is missing";
	const bytes = await reader.read(program.sector * SECTOR, program.size);
	const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
	let crc = 0;
	for(let i = 0; i < words.length; i++) crc ^= words[i];
	crc >>>= 0;
	if(crc !== GAME_CRC) return "this is Champions: Return to Arms, but not the version this page is made for, or a changed or damaged copy (its program's checksum is " + crc.toString(16).toUpperCase().padStart(8, "0") + "; wanted is version 2.00, " + GAME_CRC.toString(16).toUpperCase() + ")";
	return "";
}

function writeString(text) {
	const bytes = new TextEncoder().encode(text);
	const pointer = module._malloc(bytes.length + 1);
	module.HEAPU8.set(bytes, pointer);
	module.HEAPU8[pointer + bytes.length] = 0;
	return pointer;
}

// 'file': the picked file behind the URL (null: the URL is a server's).
async function boot(reader, url, name, file = null) {
	setStatus("Checking the disc image…");
	progress("busy");
	let refusal;
	try { refusal = await checkDisc(reader); } catch(e) {
		refusal = "the file could not be read (" + (/NotReadable|NotFound|Security|NotAllowed/.test(e.name) ? "the browser may not read it any more, or it is no longer where it was" : e.message) + ")";
	}
	progress(null);
	if(refusal) {
		setStatus((running ? "Not taken: " : "Not started: ") + refusal + ".", true);
		return false;
	}
	discFile = file;
	// a browser that answers no range requests on a picked file from a thread: the pieces go through this thread (rtaDiscRead)
	if(module._RtaWebDiscMode) module._RtaWebDiscMode(file && (!check.has.discInPlace || params.get("discread") === "page") ? 1 : 0);
	const urlPointer = writeString(url), namePointer = writeString(name);
	module._RtaWebDiscSet(urlPointer, reader.size);
	// When the game runs already it is waiting for its disc (discWatch): it goes on with this one.
	if(!running) { module._rtaBoot(namePointer); performance.mark("rta-boot"); }
	module._free(urlPointer);
	module._free(namePointer);
	const first = !running;
	running = true;
	discLost = false;
	discGrace = performance.now() + 2500; // a read that failed while the new image was being put in is not counted against it
	$("start").hidden = true;
	canvas.focus();
	setStatus("Running.");
	keepAwake();
	if(first) firstHints();
	return true;
}
// Mode 1 of the disc stream (Js_DiscImageDeviceStream.cpp): the machine's thread asks for a
// piece of the picked file and waits; it is put into the shared memory here.
function discReadForMachine(position, buffer, size) {
	const file = discFile;
	(file ? file.slice(position, position + size).arrayBuffer() : Promise.reject(new Error("no file"))).then(
		(data) => { module.HEAPU8.set(new Uint8Array(data), buffer); module._RtaWebDiscDone(data.byteLength); },
		(e) => { note("disc: a piece could not be read (" + e + ")"); module._RtaWebDiscDone(-1); });
}
// The image cannot be read any more (the file was moved or renamed, its drive removed, or
// the browser's permission taken back): the machine waits and asks again; the player is
// told and can choose the file again, and the game goes on where it stood.
let discLost = false, discErrors = 0, discQuiet = 0, discGrace = 0;
function discWatch(errors) {
	const more = errors > discErrors && performance.now() > discGrace;
	discErrors = errors;
	if(discLost && !more && ++discQuiet >= 3) {
		// three seconds without a failed read: the same file is there again (its drive came back)
		discLost = false;
		$("start").hidden = true;
		setStatus("Running.");
		notice("The disc image can be read again.");
		canvas.focus();
	}
	if(more) discQuiet = 0;
	if(!more || discLost || !running) return;
	discLost = true;
	$("start").hidden = false;
	$("choose").hidden = false;
	setStatus(options.disc ? "The disc image can no longer be read from the test server." :
		"The game is waiting: your disc image can no longer be read. The file was moved or renamed, its drive was removed, or the browser's permission to read it has ended. Choose it again and the game goes on where it stood.", true);
	notice("");
}
// What a new player is not told by the game itself: once per visit, after the start.
function firstHints() {
	const parts = [];
	if(options.sound && check.has.audioWorklet && (!audio || audio.context.state !== "running")) parts.push("Sound starts with your next click or key press.");
	if(check.has.gamepads && !activePad()) parts.push("Controller: press a button on it and it is in use.");
	parts.push("Keys and controller buttons are under Controls.");
	notice(parts.join(" "), false, 14000);
	if(options.touch === "on" || (options.touch === "auto" && check.has.touch && !check.has.finePointer)) touchPad(true);
	if(navigator.storage && navigator.storage.persist && card.kept && !/Firefox/.test(navigator.userAgent)) {
		// asks the browser not to clear the saved games when it runs short of room (Firefox would put a question to the player: not asked there)
		navigator.storage.persist().then((kept) => note("storage: " + (kept ? "kept by the browser for good" : "may be cleared by the browser when it runs short of room"))).catch(() => {});
	}
}

// The screen stays on while the game runs. A controller does not count as activity for
// the computer's idle timer, and when the screen is switched off or the computer sleeps a
// browser closes the page's connections: an online game would be lost.
let wakeLock = null;
async function keepAwake() {
	if(!running || wakeLock || !navigator.wakeLock || document.hidden) return;
	try {
		wakeLock = await navigator.wakeLock.request("screen");
		wakeLock.addEventListener("release", () => { wakeLock = null; });
	} catch(e) { /* the browser does not allow it now; asked again when the page is shown again */ }
}
document.addEventListener("visibilitychange", keepAwake);

// The image the player picked. It is read in place, through a URL that only this page
// can use (URL.createObjectURL): nothing is copied and nothing leaves the computer.
async function bootFile(file, handle) {
	const url = URL.createObjectURL(file);
	const ok = await boot(fileReader(file), url, /\.(bin|img)$/i.test(file.name) ? "disc.bin" : "disc.iso", file);
	if(!ok) { URL.revokeObjectURL(url); return false; }
	if(discUrl) URL.revokeObjectURL(discUrl);
	discUrl = url;
	if(handle) await remember("disc", handle);
	showDisc(file.name, !!handle);
	return true;
}
let discUrl = null;
function showDisc(name, kept) {
	$("discSay").textContent = name ? "In use: " + name + (kept ? ". This browser remembers where it is and offers it at the next visit." : check.has.filePicker ? "." : ". This browser cannot remember a file: you choose it at every visit.") : "";
	$("discForget").hidden = !kept;
}
// A file dropped on the page is taken like a chosen one (and remembered, where the browser hands out a handle for it).
function dropTarget(event) {
	return (!running || discLost) && module && rta.state !== "loading" && event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files");
}
for(const kind of ["dragenter", "dragover"]) {
	window.addEventListener(kind, (event) => {
		if(!dropTarget(event)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		$("start").classList.add("drop");
	});
}
window.addEventListener("dragleave", () => $("start").classList.remove("drop"));
window.addEventListener("drop", async (event) => {
	$("start").classList.remove("drop");
	if(!dropTarget(event)) return;
	event.preventDefault();
	const item = event.dataTransfer.items && event.dataTransfer.items[0];
	let file = event.dataTransfer.files[0], handle = null;
	try {
		// asked for before anything is awaited: the items are gone afterwards
		const asked = item && item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;
		handle = asked ? await asked : null;
		if(handle && handle.kind !== "file") { setStatus("That is a folder: drop the disc image itself.", true); return; }
		if(handle) file = await handle.getFile();
	} catch(e) { handle = null; }
	startSound();
	if(file) await bootFile(file, handle);
});

// A small store in the browser's database: the handle of the picked file can be kept
// there (browsers with the File System Access interface), so that the next visit only
// asks "may this page read it again?" instead of for the file.
function database() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open("rta-web", 1);
		request.onupgradeneeded = () => request.result.createObjectStore("kept");
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
async function remember(key, value) {
	try {
		const db = await database();
		await new Promise((resolve, reject) => {
			const transaction = db.transaction("kept", "readwrite");
			if(value === null) transaction.objectStore("kept").delete(key); else transaction.objectStore("kept").put(value, key);
			transaction.oncomplete = resolve;
			transaction.onerror = () => reject(transaction.error);
		});
	} catch(e) { note("the disc image's place could not be remembered (" + e + ")"); }
}
async function remembered(key) {
	try {
		const db = await database();
		return await new Promise((resolve, reject) => {
			const request = db.transaction("kept").objectStore("kept").get(key);
			request.onsuccess = () => resolve(request.result ?? null);
			request.onerror = () => reject(request.error);
		});
	} catch(e) { return null; }
}

$("choose").addEventListener("click", async () => {
	startSound();
	if(!window.showOpenFilePicker) { $("discFile").click(); return; }
	let handle;
	try {
		[handle] = await window.showOpenFilePicker({ id: "rta-disc", types: [{ description: "Disc image", accept: { "application/octet-stream": [".iso", ".bin", ".img"] } }] });
	} catch(e) {
		if(e.name !== "AbortError") { note("file dialog: " + e); $("discFile").click(); } // AbortError: closed without choosing
		return;
	}
	try { await bootFile(await handle.getFile(), handle); } catch(e) { setStatus("The file could not be opened (" + e.message + ").", true); }
});
$("discFile").addEventListener("change", async (event) => {
	const file = event.target.files[0];
	event.target.value = ""; // the same file can be chosen again
	if(file && module) await bootFile(file, null);
});
$("resume").addEventListener("click", async () => {
	startSound();
	const handle = await remembered("disc");
	if(!handle) return;
	try {
		if((await handle.queryPermission({ mode: "read" })) !== "granted" && (await handle.requestPermission({ mode: "read" })) !== "granted") {
			setStatus("The browser asked whether this page may read " + handle.name + " again and the answer was no (or the question was closed). Press the button again and allow it, or choose the file once more.", true);
			return;
		}
		await bootFile(await handle.getFile(), handle);
	} catch(e) {
		setStatus(handle.name + " is no longer where it was (moved, renamed, or its drive is not attached). Choose your disc image again.", true);
		note("remembered image: " + e);
		await remember("disc", null);
		$("resume").hidden = true;
		$("choose").textContent = "Choose your disc image…";
	}
});
$("discForget").addEventListener("click", async () => {
	await remember("disc", null);
	showDisc(discFile ? discFile.name : "", false);
	notice("Forgotten: the next visit asks for the disc image.");
});
$("change").addEventListener("click", async () => { await flushCard(); location.reload(); });

// Full screen: the picture with what lies over it (pause, notices, the on-screen pad).
function fullScreenElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
function fullScreen() {
	const stage = document.querySelector("main");
	if(fullScreenElement()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
	const request = stage.requestFullscreen || stage.webkitRequestFullscreen;
	if(!request) { notice("This browser has no full screen for a page" + (check.has.system === "iPhone or iPad" ? " (on an iPhone or iPad: Share → Add to Home Screen opens the page without the browser's bars)" : "") + ".", true); return; }
	try {
		const asked = request.call(stage);
		if(asked && asked.catch) asked.catch((e) => notice("The browser refused full screen (" + e.message + ").", true));
	} catch(e) { notice("The browser refused full screen (" + e.message + ").", true); }
}
$("fullscreen").addEventListener("click", () => { fullScreen(); canvas.focus(); });
canvas.addEventListener("dblclick", fullScreen);
for(const kind of ["fullscreenchange", "webkitfullscreenchange"]) {
	document.addEventListener(kind, () => { $("fullscreen").textContent = fullScreenElement() ? "Leave full screen" : "Full screen"; canvas.focus(); });
}
$("help").addEventListener("click", () => { if(panel("controls")) showBindings(); });
$("settingsButton").addEventListener("click", () => { if(panel("settings")) showCard(); });
function showMute() {
	const asleep = !options.muted && running && options.sound && (!audio || audio.context.state !== "running") && !pausedBy;
	$("mute").textContent = options.muted ? "Sound off" : "Sound on";
	$("mute").title = asleep ? "The browser lets a page make sound only after a click or a key press on it" : "";
	$("mute").setAttribute("aria-pressed", String(options.muted));
	if(audio && audio.node) audio.node.port.postMessage({ muted: options.muted, volume: (options.volume / 100) ** 2 });
}
$("volume").value = String(options.volume);
$("volumeSay").textContent = options.volume + " %";
$("volume").addEventListener("input", () => {
	options.volume = parseInt($("volume").value, 10);
	$("volumeSay").textContent = options.volume + " %";
	store("volume", String(options.volume));
	if(options.muted && options.volume > 0) { options.muted = false; store("muted", "0"); }
	startSound();
	showMute();
});
$("mute").addEventListener("click", () => {
	options.muted = !options.muted;
	store("muted", options.muted ? "1" : "0");
	startSound();
	showMute();
	canvas.focus();
});
if(!options.sound) $("mute").hidden = true;

// ---- input --------------------------------------------------------------------------
// Which key and which controller button is which: 'keyOf' (control -> key), and for a
// controller a table per controller (by the name the browser gives it), both kept in this
// browser's storage. A controller the browser reports with the "standard" layout needs
// no table; any other starts with the same numbers as a guess and can be set button by
// button under Controls.
function parsed(text, fallback) {
	try { const value = JSON.parse(text); return value && typeof value === "object" ? value : fallback; } catch(e) { return fallback; }
}
const keyOf = { ...DEFAULT_KEYS, ...parsed(stored("keys", "{}"), {}) };
let controlOfKey = {};
function keysChanged() {
	controlOfKey = {};
	for(const [control] of CONTROLS) if(keyOf[control]) controlOfKey[keyOf[control]] = control;
}
keysChanged();
const padMaps = parsed(stored("pads", "{}"), {});
let padInUse = -1, padName = "", padHeld = false;
const touchDown = new Map();   // the on-screen pad: control -> how far (0..1)
let asking = null;             // Controls: { control, kind: "key" | "pad", queue, rest, wait } while a key or a button is waited for

function padMapOf(pad) { return padMaps[pad.id] || DEFAULT_PAD; }
function shortPad(id) { return id.replace(/\s*\((STANDARD GAMEPAD\s*)?Vendor:.*$/i, "").replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, "").trim() || id; }
// A button's value: browsers give "pressed", a value from 0 to 1 (triggers), or both.
function buttonValue(button) {
	if(!button) return 0;
	const value = button.value || 0;
	return Math.max(value, button.pressed && !(value > 0) ? 1 : 0);
}
// how far one source of a controller is pushed, 0..1
function padSource(pad, source) {
	if(!source) return 0;
	const index = parseInt(source.slice(1), 10);
	if(source[0] === "b") return buttonValue(pad.buttons[index]);
	const value = pad.axes[index];
	if(value === undefined) return 0;
	if(source[0] === "a") return Math.max(0, source.endsWith("-") ? -value : value);
	// a hat switch as one axis: eight places clockwise from up (-1) in steps of 2/7, beyond 1 at rest
	if(Math.abs(value) > 1.05) return 0;
	const place = Math.round((value + 1) * 3.5) % 8, wanted = "urdl".indexOf(source[source.length - 1]) * 2;
	return place === wanted || place === (wanted + 1) % 8 || place === (wanted + 7) % 8 ? 1 : 0;
}
function padBusy(pad) { return pad.buttons.some((button) => buttonValue(button) > 0.5); }
// The controller in use is the one a button was pressed on last: a browser shows a
// controller to a page only after a button press on it, and may list things that are none.
function activePad() {
	// The input is sampled often to keep controller latency low on Windows. Avoid
	// allocating an array, filtering it and searching it twice on every sample.
	let pad = null, preferred = null, firstBusy = null;
	try {
		const pads = navigator.getGamepads ? navigator.getGamepads() : null;
		if(pads) for(const one of pads) {
			if(!one || !one.connected) continue;
			if(one.index === padInUse) preferred = one;
			if(!firstBusy && padBusy(one)) firstBusy = one;
		}
		pad = preferred && padBusy(preferred) ? preferred : firstBusy || preferred;
	} catch(e) { /* gamepads may not be allowed in this browser */ }
	if(!pad) { padInUse = -1; return null; }
	if(pad.index !== padInUse || pad.id !== padName) {
		padInUse = pad.index;
		padName = pad.id;
		note("controller: " + pad.id + " (" + (pad.mapping || "no standard layout") + ")");
		if(pad.mapping !== "standard" && !padMaps[pad.id]) {
			notice("This controller (" + shortPad(pad.id) + ") has no standard layout in this browser. If its buttons are wrong: Controls → Set up the controller.", false, 15000);
		} else if(running) notice("Controller in use: " + shortPad(pad.id) + ".", false, 5000);
		if(!$("controls").hidden) showBindings();
	}
	return pad;
}
// nothing inside 15 % of the way, then evenly to the edge
function pushed(value) { return value < 0.15 ? 0 : Math.min(1, (value - 0.15) / 0.85); }

function readInput() {
	if(!module || !shared) return;
	const pad = activePad();
	if(asking) askStep(pad);
	if(pad && pausedBy === "hidden" && !document.hidden && padBusy(pad)) { padHeld = true; resume(); }
	if(padHeld && !(pad && padBusy(pad))) padHeld = false; // the press that ended the pause is not passed on
	const how = {}; // control -> how far, 0..1
	if(!asking && !pausedBy) {
		for(const code of keysDown) { const control = controlOfKey[code]; if(control) how[control] = 1; }
		for(const [control, value] of touchDown) how[control] = Math.max(how[control] || 0, value);
		if(pad && !padHeld) {
			const map = padMapOf(pad);
			for(const [control] of CONTROLS) {
				const source = map[control];
				if(!source) continue;
				let value = padSource(pad, source);
				if(control in STICKS) value = source[0] === "a" ? pushed(value) : (value > 0.5 ? 1 : 0);
				else value = value > (source[0] === "b" ? 0.3 : 0.5) ? 1 : 0; // a trigger counts beyond 30 %
				if(value > (how[control] || 0)) how[control] = value;
			}
			if(pad.mapping === "standard" && !padMaps[pad.id] && buttonValue(pad.buttons[17]) > 0.3) how.select = 1; // a PlayStation pad's touchpad
		}
	}
	let buttons = 0, axesSet = 0;
	const axes = [0, 0, 0, 0];
	for(const control in how) {
		if(!how[control]) continue;
		const stick = STICKS[control];
		if(stick) axes[stick[0] * 2 + stick[1]] += stick[2] * how[control];
		else buttons |= 1 << B[control];
	}
	const words = module.HEAPU32;
	for(let i = 0; i < 4; i++) {
		const value = Math.max(-1, Math.min(1, axes[i]));
		const word = Math.round(128 + value * (value < 0 ? 128 : 127));
		words[shared + 1 + i] = word;
		if(word !== 128) axesSet |= 1 << (i >> 1);
	}
	words[shared + 0] = buttons;
	words[shared + 5] = axesSet;
}

// Controls: a key or a controller button for every control, chosen by pressing it.
let keyNames = null; // what is printed on the keys of this keyboard, where the browser tells
if(navigator.keyboard && navigator.keyboard.getLayoutMap) {
	navigator.keyboard.getLayoutMap().then((map) => { keyNames = map; if(!$("controls").hidden) showBindings(); }).catch(() => {});
}
function keyName(code) {
	if(!code) return "—";
	const named = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Space", ShiftLeft: "left Shift", ShiftRight: "right Shift", ControlLeft: "left Ctrl", ControlRight: "right Ctrl", AltLeft: "left Alt", AltRight: "right Alt" };
	if(named[code]) return named[code];
	const printed = keyNames && keyNames.get(code);
	if(printed) return printed.toUpperCase();
	return code.replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num ");
}
function sourceName(source) {
	if(!source) return "—";
	const number = source.slice(1).replace(/[-+urdl]$/, "");
	if(source[0] === "b") return "button " + number;
	if(source[0] === "a") return "axis " + number + (source.endsWith("-") ? " −" : " +");
	return "hat " + number + " " + { u: "↑", r: "→", d: "↓", l: "←" }[source[source.length - 1]];
}
function labelOf(control) { return CONTROLS.find((one) => one[0] === control)[1]; }
function ask(control, kind, queue = []) {
	const pad = kind === "pad" ? activePad() : null;
	if(kind === "pad" && !pad) { notice("Press a button on the controller first: a browser shows a controller to a page only then.", true); return; }
	asking = { control, kind, queue, rest: pad ? Array.from(pad.axes) : [], wait: true };
	keysDown.clear();
	showBindings();
}
// one look at the controller while a button of it is waited for
function askStep(pad) {
	if(asking.kind !== "pad" || !pad) return;
	const moved = [];
	pad.buttons.forEach((button, index) => { if(buttonValue(button) > 0.5) moved.push("b" + index); });
	pad.axes.forEach((value, index) => {
		const rest = asking.rest[index] || 0;
		if(Math.abs(rest) > 1.05) { // a hat switch: beyond 1 at rest
			const place = Math.round((value + 1) * 3.5) % 8;
			if(Math.abs(value) <= 1.05 && place % 2 === 0) moved.push("h" + index + "urdl"[place / 2]);
		} else if(Math.abs(value - rest) > 0.6) moved.push("a" + index + (value > rest ? "+" : "-"));
	});
	if(asking.wait) { if(!moved.length) asking.wait = false; return; } // everything let go first
	if(!moved.length) return;
	padMaps[pad.id] = { ...padMapOf(pad), [asking.control]: moved[0] };
	store("pads", JSON.stringify(padMaps));
	askNext();
}
function askNext() {
	const next = asking && asking.queue.shift();
	asking = next ? { ...asking, control: next, wait: true } : null;
	showBindings();
}
function showBindings() {
	const table = $("bindings");
	table.textContent = "";
	const pad = activePad();
	const map = pad ? padMapOf(pad) : DEFAULT_PAD;
	for(const [control, label] of CONTROLS) {
		const row = table.insertRow();
		row.insertCell().textContent = label;
		for(const kind of ["key", "pad"]) {
			const button = row.insertCell().appendChild(document.createElement("button"));
			const waiting = !!asking && asking.control === control && asking.kind === kind;
			button.type = "button";
			button.textContent = waiting ? "press it…" : kind === "key" ? keyName(keyOf[control]) : sourceName(map[control]);
			button.classList.toggle("ask", waiting);
			button.title = "Click, then press the " + (kind === "key" ? "key" : "controller's button") + " for " + label;
			button.addEventListener("click", () => { if(waiting) { asking = null; showBindings(); } else ask(control, kind); });
		}
	}
	$("padname").textContent = !check.has.gamepads ? "This browser shows no game controllers to a page." :
		!pad ? "No controller yet: plug one in or pair it, then press a button on it (a browser shows it to a page only then)." :
		"Controller in use: " + shortPad(pad.id) + (padMaps[pad.id] ? " (buttons as set here)." : pad.mapping === "standard" ? " (standard layout: nothing to set)." : " (no standard layout in this browser: the buttons shown are a guess).");
	$("askSay").textContent = !asking ? "" : (asking.kind === "key" ? "Press the key for " : "Press the controller's button, or push its stick, for ") + labelOf(asking.control) + ". Esc leaves it as it is.";
	$("padSkip").hidden = !(asking && asking.kind === "pad" && asking.queue.length);
	$("padSetup").disabled = !pad;
	$("padReset").disabled = !(pad && padMaps[pad.id]);
}
$("padSetup").addEventListener("click", () => ask(CONTROLS[0][0], "pad", CONTROLS.slice(1).map((one) => one[0])));
$("padSkip").addEventListener("click", askNext);
$("padReset").addEventListener("click", () => {
	const pad = activePad();
	if(pad) delete padMaps[pad.id];
	store("pads", JSON.stringify(padMaps));
	asking = null;
	showBindings();
});
$("keysReset").addEventListener("click", () => {
	Object.assign(keyOf, DEFAULT_KEYS);
	store("keys", "{}");
	keysChanged();
	asking = null;
	showBindings();
});

window.addEventListener("keydown", (event) => {
	if(asking && (asking.kind === "key" || event.code === "Escape")) {
		event.preventDefault();
		if(event.code !== "Escape") {
			for(const [control] of CONTROLS) if(keyOf[control] === event.code) keyOf[control] = ""; // a key is one control's
			keyOf[asking.control] = event.code;
			store("keys", JSON.stringify(keyOf));
			keysChanged();
		}
		asking = null;
		showBindings();
		return;
	}
	if(!running || event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) return;
	if(pausedBy === "hidden") {
		if(!["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) { event.preventDefault(); startSound(); resume(); }
		return;
	}
	if(event.code in controlOfKey) {
		keysDown.add(event.code);
		event.preventDefault();
		startSound();
		readInput();
	}
});
window.addEventListener("keyup", (event) => {
	// with the command key held a Mac does not report other keys being let go
	if(event.key === "Meta") keysDown.clear(); else keysDown.delete(event.code);
	readInput();
});
window.addEventListener("blur", () => { keysDown.clear(); touchDown.clear(); readInput(); });
window.addEventListener("gamepadconnected", (event) => { note("controller attached: " + event.gamepad.id + " (" + (event.gamepad.mapping || "no standard layout") + ")"); readInput(); });
window.addEventListener("gamepaddisconnected", (event) => {
	note("controller gone: " + event.gamepad.id);
	if(event.gamepad.index === padInUse && running) notice("The controller is gone (switched off, out of reach or unplugged). Keyboard works; press a button on a controller to use it.", true);
	if(!$("controls").hidden) showBindings();
});
canvas.addEventListener("pointerdown", () => { canvas.focus(); startSound(); });

// ---- the on-screen pad (touch screens) -------------------------------------------------
// A left stick, the direction pad, the four buttons, the shoulder buttons, Start and
// Select, drawn over the picture. Shown when the screen is touched (Settings: always or
// never). Plain and untried on a real device: see docs/issues/browser-build.md.
const TOUCH = [ // control, what it shows, where, a wide one
	["l2", "L2", "left:1.2em;top:1em", 1], ["l1", "L1", "left:6.2em;top:1em", 1], ["r1", "R1", "right:6.2em;top:1em", 1], ["r2", "R2", "right:1.2em;top:1em", 1],
	["up", "↑", "left:4em;bottom:16.8em"], ["left", "←", "left:0.5em;bottom:13.6em"], ["right", "→", "left:7.5em;bottom:13.6em"], ["down", "↓", "left:4em;bottom:10.4em"],
	["triangle", "△", "right:4.5em;bottom:9.4em"], ["square", "□", "right:8em;bottom:5.7em"], ["circle", "○", "right:1em;bottom:5.7em"], ["cross", "✕", "right:4.5em;bottom:2em"],
	["select", "Select", "left:calc(50% - 5em);bottom:1em", 1], ["start", "Start", "left:calc(50% + 0.6em);bottom:1em", 1],
];
let touchBuilt = false;
function touchPad(show) {
	const root = $("touch");
	if(show && !touchBuilt) {
		touchBuilt = true;
		for(const [control, text, place, wide] of TOUCH) {
			const button = root.appendChild(document.createElement("button"));
			button.type = "button";
			button.textContent = text;
			button.style.cssText = place;
			button.tabIndex = -1;
			button.setAttribute("aria-label", labelOf(control));
			if(wide) button.className = "wide";
			const set = (down) => (event) => {
				event.preventDefault();
				if(down) { touchDown.set(control, 1); try { button.setPointerCapture(event.pointerId); } catch(e) { /* gone already */ } startSound(); } else touchDown.delete(control);
				button.classList.toggle("on", down);
				readInput();
			};
			button.addEventListener("pointerdown", set(true));
			for(const kind of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(kind, set(false));
			button.addEventListener("contextmenu", (event) => event.preventDefault());
		}
		const stick = root.appendChild(document.createElement("div")), knob = stick.appendChild(document.createElement("i"));
		const directions = ["ls-left", "ls-right", "ls-up", "ls-down"];
		stick.id = "touchStick";
		const move = (event) => {
			event.preventDefault();
			const box = stick.getBoundingClientRect(), reach = box.width * 0.35;
			let x = (event.clientX - box.left - box.width / 2) / reach, y = (event.clientY - box.top - box.height / 2) / reach;
			const length = Math.hypot(x, y);
			if(length > 1) { x /= length; y /= length; }
			knob.style.transform = "translate(" + (x * reach).toFixed(1) + "px," + (y * reach).toFixed(1) + "px)";
			[-x, x, -y, y].forEach((value, index) => touchDown.set(directions[index], Math.max(0, value)));
			readInput();
		};
		const end = (event) => {
			event.preventDefault();
			knob.style.transform = "";
			for(const direction of directions) touchDown.delete(direction);
			readInput();
		};
		stick.addEventListener("pointerdown", (event) => { try { stick.setPointerCapture(event.pointerId); } catch(e) { /* gone already */ } startSound(); move(event); });
		stick.addEventListener("pointermove", (event) => { if(stick.hasPointerCapture(event.pointerId)) move(event); });
		for(const kind of ["pointerup", "pointercancel", "lostpointercapture"]) stick.addEventListener(kind, end);
		stick.addEventListener("contextmenu", (event) => event.preventDefault());
	}
	root.hidden = !show;
	if(!show) { touchDown.clear(); if(shared) readInput(); }
}
$("touchMode").value = options.touch;
$("touchMode").addEventListener("change", () => {
	options.touch = $("touchMode").value;
	store("touch", options.touch);
	touchPad(running && (options.touch === "on" || (options.touch === "auto" && check.has.touch)));
});
// "when the screen is touched": the first touch on the picture brings the pad
window.addEventListener("pointerdown", (event) => {
	if(event.pointerType === "touch" && options.touch === "auto" && running && $("touch").hidden) touchPad(true);
}, true);

// ---- pause --------------------------------------------------------------------------
// A browser runs a page that is not in front slowly and lets its timers run late. A game
// played alone is paused then, with a plain sign over the picture, and goes on at a
// click, a key or a controller button. An online game cannot be paused - every machine in
// it waits for every other - so the player is told instead: before (when going online
// starts), meanwhile (the tab's title) and afterwards.
const pageTitle = document.title;
let hiddenOnlineSince = 0, onlineWarned = false;
// Online: the page is going online, other players' copies are heard, or the game's machine
// has used its network in the last twenty seconds (in the lobby too: paused there, the
// machine would be dropped by the server).
const network = { sent: 0, at: -1e9 };
function playingOnline() {
	if(!(online.relay && online.welcomed && online.state)) return false;
	return !!(online.state.active || (online.players && online.players.players > 0) || performance.now() - network.at < 20000);
}
function pause(why, text) {
	if(!running || pausedBy) return;
	pausedBy = why;
	module._rtaPause(1);
	if(audio) audio.context.suspend().catch(() => {});
	keysDown.clear();
	touchDown.clear();
	readInput();
	$("pausedWhy").textContent = text;
	$("paused").hidden = false;
	note("paused (" + why + ")");
}
function resume() {
	if(!pausedBy) return;
	pausedBy = "";
	$("paused").hidden = true;
	module._rtaPause(0);
	if(audio) audio.context.resume().catch(() => {});
	canvas.focus();
	keepAwake();
	note("going on");
}
$("paused").addEventListener("click", () => { startSound(); resume(); });
document.addEventListener("visibilitychange", () => {
	if(!running) return;
	if(document.hidden) {
		saveCard();
		if(playingOnline()) {
			hiddenOnlineSince = performance.now();
			document.title = "⚠ Come back: the others are waiting";
		} else if(options.autoPause) pause("hidden", "The page was not in front.");
	} else {
		document.title = pageTitle;
		if(hiddenOnlineSince) {
			const seconds = Math.round((performance.now() - hiddenOnlineSince) / 1000);
			hiddenOnlineSince = 0;
			if(seconds >= 2) notice("This page was hidden for " + seconds + " s. A browser runs a hidden page slowly, and an online game waits for every player's machine: keep the page in front while you play online.", true, 15000);
		}
	}
});
// once a second (the figures' timer): the warning before an online game, and the sound's and the disc's state
function watch(now) {
	const sent = (online.state && online.state.messages_out) || 0;
	if(sent !== network.sent) { network.sent = sent; network.at = performance.now(); }
	if(playingOnline() && !onlineWarned) {
		onlineWarned = true;
		notice("Online: keep this page in front, its window uncovered and the computer awake until you are done. A hidden page runs slowly, and an online game waits for every player's machine.", false, 16000);
	}
	discWatch(now.disc_errors || 0);
	showMute();
	// A machine that for half a minute makes no frame, translates no code and reads nothing,
	// although nothing holds it, has stopped. (Translating a level's code alone can take
	// seconds without a frame in a browser that is slow at it.)
	const work = now.frames + ":" + now.functions + ":" + now.disc_fetches;
	if(work !== stall.work || pausedBy || discLost || document.hidden) { stall.work = work; stall.since = now.now; stall.told = false; }
	else if(!stall.told && now.now - stall.since > 30000) {
		stall.told = true;
		notice("The game has stood still for half a minute: the emulator seems to have stopped. Load the page again; what the game had saved is kept.", true, 0);
	}
}
const stall = { work: "", since: 0, told: false };

// ---- online play ----------------------------------------------------------------------
// A page has no sockets of its own. The console's network (the desktop application's,
// compiled in: tools/play-web/src/RtaWebNet.cpp) hands what it wants sent to this thread,
// which owns the one WebSocket connection to the relay; what the relay sends goes back
// the same way. Going online itself - title screen, network setting, terms, log-in, a
// game by code - is the desktop application's "one-step online", also compiled in: this
// page only asks for the player name, starts it and shows what it says.
const online = {
	relay: null,        // the relay's address; null: this page has none and nothing below is shown
	signin: null,       // the name of the sign-in patch file
	signinLoaded: false,
	socket: null,
	welcomed: false,
	lastTry: -1e9,
	buffer: 0,          // a piece of the module's memory for handing messages over
	notice: "",         // what the relay said last (why it refused something, or closed)
	rtt: [],            // the last round trips to the relay, in milliseconds
	pongs: new Map(),
	state: null,
	players: null,      // what onlinePlayers() made of the other players' copies
	codeShown: "",
};
const RELAY_BUFFER = 16384;

// A relay that carries browser players only (online.json: "mixed": false): the page must not
// offer what does not come about there.
function onlinePagesOnly() {
	const who = document.getElementById("onlineWho");
	if(who) who.textContent = "Here browser players play with browser players: a game with players of the Mac application does not come about on this server yet (in one you would stay in the room, and the start would fail).";
	const button = document.getElementById("onlineButton");
	if(button) button.title = "Play with friends who also play in a browser";
}

async function onlineConfig() {
	try {
		const response = await fetch("online.json", { cache: "no-store" });
		if(response.ok) {
			const setting = await response.json();
			if(typeof setting.relay === "string" && setting.relay) {
				const url = new URL(setting.relay, location.href);
				if(url.protocol === "http:") url.protocol = "ws:";
				if(url.protocol === "https:") url.protocol = "wss:";
				online.relay = url.href;
			}
			if(typeof setting.signin === "string" && /^[\w.-]+$/.test(setting.signin)) online.signin = setting.signin;
			if(setting.mixed === false) onlinePagesOnly();
		}
	} catch(e) { /* no such file: a page without online play */ }
	// DEV: a relay on the developer's own computer
	const given = params.get("relay");
	if(given && /^ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(given)) online.relay = given;
	return online.relay !== null;
}

function relayConnect() {
	if(!online.relay || online.socket || !module) return;
	const now = performance.now();
	if(now - online.lastTry < 3000) return;
	online.lastTry = now;
	module._rtaNetLink(1);
	let socket;
	try { socket = new WebSocket(online.relay); } catch(e) { module._rtaNetLink(0); note("relay: " + e); return; }
	socket.binaryType = "arraybuffer";
	online.socket = socket;
	socket.onopen = () => socket.send(new Uint8Array([1, 1])); // HELLO, version 1
	socket.onmessage = (event) => {
		const bytes = new Uint8Array(event.data);
		if(bytes.length < 1 || bytes.length > RELAY_BUFFER) return;
		if(bytes[0] === 0x89) { // PONG
			const key = bytes.length >= 9 ? new DataView(bytes.buffer).getFloat64(1) : -1;
			const pending = online.pongs.get(key);
			if(pending) { online.pongs.delete(key); pending(performance.now() - key); }
			return;
		}
		if(bytes[0] === 0x8A) { // NOTICE: why something was refused, or why the session ends
			online.notice = new TextDecoder().decode(bytes.subarray(2));
			note("relay: " + online.notice);
			// what the player has to know: the relay is full (1), too many pages from this address (2),
			// a limit of this address - log-ins, new accounts, requests, new connections (8)
			if(bytes[1] === 1 || bytes[1] === 2 || bytes[1] === 8) notice("Online: " + online.notice + ".", true, 20000);
			return;
		}
		module.HEAPU8.set(bytes, online.buffer);
		module._rtaNetGive(online.buffer, bytes.length);
		if(bytes[0] === 0x81) {
			online.welcomed = true;
			online.notice = "";
			note("relay: connected");
			relayDrain();
		}
	};
	socket.onclose = (event) => {
		if(online.socket !== socket) return;
		online.socket = null;
		online.welcomed = false;
		online.pongs.clear();
		module._rtaNetLink(0);
		note("relay: the connection is closed (" + (online.notice || (event.wasClean ? "by the relay" : "it broke")) + "; code " + event.code + ")");
	};
}
// what the console's network wants sent
function relayDrain() {
	if(!online.welcomed || !online.socket || online.socket.readyState !== WebSocket.OPEN) return;
	for(let n; (n = module._rtaNetTake(online.buffer, RELAY_BUFFER)) > 0;) {
		online.socket.send(module.HEAPU8.slice(online.buffer, online.buffer + n)); // a copy: the module's memory is shared
	}
}
// one round trip to the relay, in milliseconds (null: none within three seconds)
function relayPing() {
	return new Promise((resolve) => {
		if(!online.welcomed) { resolve(null); return; }
		const key = performance.now();
		const message = new Uint8Array(9);
		message[0] = 9;
		new DataView(message.buffer).setFloat64(1, key);
		online.pongs.set(key, resolve);
		online.socket.send(message);
		sleep(3000).then(() => { if(online.pongs.delete(key)) resolve(null); });
	});
}

function onlineState() {
	return JSON.parse(module.UTF8ToString(module._rtaOnlineState()));
}
function onlineCall(name, ...texts) {
	const pointers = texts.map((text) => (typeof text === "string" ? writeString(text) : text));
	const result = module[name](...pointers);
	texts.forEach((text, index) => { if(typeof text === "string") module._free(pointers[index]); });
	return result;
}
// mode: 0 the lobby, 1 host a game, 2 join the game with the code
function onlineStart(mode, code = "") {
	if(!online.relay || !module) return "this page has no online play";
	if(!online.signinLoaded) return "this copy of the page has no sign-in patch: the game cannot get past its sign-in step";
	if(!running) return "start the game first: choose your disc image";
	relayConnect();
	const wrong = module.UTF8ToString(onlineCall("_rtaOnlineStart", mode, code.trim(), $("chooseCharacter").checked ? 1 : 0));
	if(!wrong) { online.codeShown = ""; canvas.focus(); }
	return wrong;
}
function onlineSay(text, bad = false) {
	$("onlineSay").textContent = text;
	$("onlineSay").classList.toggle("bad", bad);
}
// The other players' copies, as each told ours (tools/play-net/src/RtaNet.cpp: the patch-set
// figure and the arithmetic, player to player). The game computes every frame on every
// machine: a copy with other patches, or one that rounds differently, falls out of step. These
// are the two warnings of the desktop application (CheckPatchSets and CheckArithmetic in
// tools/play-net/src/Rta.cpp), by the same rules: a player not heard for fifteen seconds has
// left; a copy has twelve seconds to say what it has; one that then says nothing about
// arithmetic is an application from before it could compute as a browser does - and one that
// has told its patch set is given six seconds (RtaNet.cpp tells such a copy "obsolete" at that
// moment, so that it warns its own player). A page has one arithmetic, the browser's; a
// current application changes to it by itself while a browser player is in its room.
function onlinePlayers(state) {
	const here = (state.players || []).filter((player) => player.silent_ms <= 15000);
	if(!here.length) return { text: "", bad: false, players: 0 };
	const settled = (player) => player.heard_ms >= 12000;
	const count = (n, one, many) => (n === 1 ? one : many);
	const otherSet = here.filter((player) => player.set_known && !player.same_set);
	const noSet = here.filter((player) => !player.set_known && settled(player));
	const cannot = here.filter((player) => (player.arith_known ? !player.can_browser : settled(player) || (player.set_known && player.heard_ms >= 6000)));
	const differ = here.filter((player) => player.arith_known && player.can_browser && !player.does_browser);
	const unheard = here.filter((player) => !settled(player) && !(player.set_known && player.arith_known) && !cannot.includes(player));
	let inGame = false;
	try { inGame = !rta.inFrontEnd(); } catch(e) { /* the machine is not up */ }
	const parts = [];
	if(otherSet.length) {
		parts.push("WARNING: " + count(otherSet.length, "another player has", "other players have") + " a DIFFERENT PATCH SET (theirs " + otherSet[0].set + ", yours " + state.patch_set +
			"): the game would fall out of step - do not start it. Everyone needs the same build: this page as it is now, and the current application.");
	}
	if(cannot.length) {
		parts.push("WARNING: " + count(cannot.length, "another player's copy", "other players' copies") + " cannot compute as a browser does (an older copy of the application, or one set to its own arithmetic)" +
			(inGame ? ": the game falls out of step." : ": the game would fall out of step - do not start it. That player needs the current application, left to choose its arithmetic by itself."));
	} else if(differ.length) {
		parts.push(inGame ? "WARNING: " + count(differ.length, "another player's copy computes", "other players' copies compute") + " differently from this page: the game falls out of step."
			: count(differ.length, "Another player's application has", "Other players' applications have") + " not changed to browser arithmetic yet: wait for this line to change before starting.");
	}
	const bad = otherSet.length > 0 || cannot.length > 0 || (differ.length > 0 && inGame);
	if(!parts.length && noSet.length) {
		parts.push(noSet.length + count(noSet.length, " other player does", " other players do") + " not say which patch set they have (an older copy?): compare the figures yourselves (yours is " + state.patch_set + ").");
	}
	if(!parts.length && unheard.length) {
		parts.push("Hearing from " + count(here.length, "the other player's copy", "the other players' copies") + "… (patch set and arithmetic: wait for this line before starting)");
	}
	if(!parts.length) {
		const apps = here.filter((player) => player.can_native).length;
		parts.push("Everyone computes the same way: " + here.length + count(here.length, " other player", " other players") + " heard, the same patch set (" + state.patch_set + "), browser arithmetic" +
			(apps ? " (" + (apps === here.length ? count(apps, "in the Mac application", "all in the Mac application") : apps + " in the Mac application") + ")" : "") + ".");
	}
	return { text: parts.join(" "), bad, wait: !bad && (differ.length > 0 || unheard.length > 0), players: here.length };
}
function onlineShow() {
	if(!module || !online.relay) return;
	const state = online.state = onlineState();
	const bar = $("onlineBar");
	const text = state.note;
	bar.hidden = !text;
	bar.classList.toggle("bad", /stopped/.test(text));
	if(bar.dataset.text !== text) {
		bar.dataset.text = text;
		bar.textContent = text;
		if(text) note("online: " + text);
	}
	// the line under it: the other players' copies
	const players = online.players = onlinePlayers(state);
	const line = $("onlinePlayers");
	line.hidden = !players.text;
	line.classList.toggle("bad", players.bad);
	line.classList.toggle("wait", !!players.wait);
	if(line.dataset.text !== players.text) {
		line.dataset.text = players.text;
		line.textContent = players.text;
		if(players.text) note("players: " + players.text);
	}
	// the name is asked for once; the panel opens by itself for it
	const ask = $("nameAsk");
	if(state.name_wanted && ask.hidden) {
		ask.hidden = false;
		$("online").hidden = false;
		$("nameWhy").textContent = state.name_why || "";
		$("playerName").focus();
	} else if(!state.name_wanted && !ask.hidden) {
		ask.hidden = true;
		canvas.focus();
	}
	for(const id of ["onlineHost", "onlineJoin", "onlineLobby"]) $(id).disabled = !!state.active;
	$("onlineStop").hidden = !state.active;
	$("onlineForget").hidden = !state.has_login || !!state.active;
	$("onlineForget").textContent = state.name ? "Forget online login (" + state.name + ")" : "Forget online login";
	const code = $("onlineCode");
	code.hidden = !state.code;
	if(state.code && online.codeShown !== state.code) {
		online.codeShown = state.code;
		code.textContent = "Game code: ";
		code.appendChild(document.createElement("b")).textContent = state.code;
	}
	if(!state.active && !$("onlineSay").classList.contains("bad")) {
		onlineSay(online.signinLoaded ? (state.has_login ? "Online as " + state.name + "." : "You will be asked for a player name, once.") : "This copy of the page has no sign-in patch: the game cannot go online.", !online.signinLoaded);
	} else if(state.active) {
		onlineSay(state.note);
	}
}
$("onlineButton").addEventListener("click", () => {
	const panel = $("online");
	panel.hidden = !panel.hidden;
	$("onlineButton").setAttribute("aria-expanded", String(!panel.hidden));
	if(panel.hidden) canvas.focus(); else onlineShow();
});
function onlineClick(mode) {
	const code = mode === 2 ? $("joinCode").value : "";
	if(mode === 2 && !code.trim()) { onlineSay("Type the code your friend's page shows.", true); $("joinCode").focus(); return; }
	const wrong = onlineStart(mode, code);
	onlineSay(wrong ? wrong.charAt(0).toUpperCase() + wrong.slice(1) + "." : "Going online…", !!wrong);
	startSound();
}
$("onlineHost").addEventListener("click", () => onlineClick(1));
$("onlineJoin").addEventListener("click", () => onlineClick(2));
$("onlineLobby").addEventListener("click", () => onlineClick(0));
$("joinCode").addEventListener("keydown", (event) => { if(event.key === "Enter") onlineClick(2); });
function onlineName() {
	const wrong = module.UTF8ToString(onlineCall("_rtaOnlineName", $("playerName").value.trim()));
	$("nameWhy").textContent = wrong;
	if(!wrong) { $("nameAsk").hidden = true; canvas.focus(); }
}
$("nameOk").addEventListener("click", onlineName);
$("playerName").addEventListener("keydown", (event) => { if(event.key === "Enter") onlineName(); });
$("onlineStop").addEventListener("click", () => { module._rtaOnlineStop(); canvas.focus(); });
$("onlineForget").addEventListener("click", () => { module._rtaOnlineForget(); saveCard(); onlineShow(); });

async function onlineLoop() {
	// by the worker's clock: a page that is not in front must not fall silent
	for(let tick = 0; ; tick++) {
		await sleep(250);
		try {
			onlineShow();
			if(tick % 60 === 59 && online.welcomed) { // every 15 s: the relay drops a page it does not hear
				const ms = await relayPing();
				if(ms !== null) { online.rtt.push(+ms.toFixed(2)); if(online.rtt.length > 40) online.rtt.shift(); }
			}
		} catch(e) { note("online: " + e); }
	}
}

// ---- sound --------------------------------------------------------------------------
// A browser lets a page make sound only after the person has done something on it: this
// is called at every click and key press until the sound runs.
function soundContext() {
	const Context = window.AudioContext || window.webkitAudioContext;
	try { return new Context({ sampleRate: 44100, latencyHint: "interactive" }); } catch(e) { return new Context(); }
}
async function startSound() {
	if(!options.sound || !module) return;
	if(audio) {
		if(audio.context.state !== "running" && !pausedBy) audio.context.resume().catch(() => {});
		return;
	}
	if(!check.has.audioWorklet) return;
	try { audio = { context: soundContext(), dry: 0, queuedMs: 0 }; } catch(e) {
		note("sound: no sound output (" + e + ")");
		options.sound = false;
		$("mute").hidden = true;
		return;
	}
	// asked for at once, inside the click or key press itself: some browsers want that
	audio.context.resume().catch(() => {});
	audio.context.onstatechange = () => { note("sound: " + audio.context.state); showMute(); };
	try {
		await audio.context.audioWorklet.addModule("rta-sound.js");
		const ring = module._rtaSoundRing();
		const size = module.HEAPU32[(ring >> 2) + 2];
		audio.node = new AudioWorkletNode(audio.context, "rta-ring", {
			numberOfInputs: 0, outputChannelCount: [2],
			processorOptions: { memory: module.wasmMemory.buffer, ring, size },
		});
		audio.node.port.onmessage = (event) => { audio.dry = event.data.dry; audio.queuedMs = event.data.queuedMs; audio.playing = event.data.playing; };
		audio.node.connect(audio.context.destination);
		showMute(); // tells the worklet the volume
		if(!pausedBy) audio.context.resume().catch(() => {});
		note("sound: started at " + audio.context.sampleRate + " Hz");
	} catch(e) {
		note("sound: could not be started (" + e + ")");
		notice("The sound could not be started in this browser (" + (e.message || e) + ").", true);
	}
}

// ---- the memory card ----------------------------------------------------------------
// Play! keeps a memory card as a folder of files. The folder lives in the browser's
// storage for this site (IndexedDB), read when the page starts and written back a moment
// after anything in it changed. One tab has it at a time; it can be saved to a file and
// loaded from one (Settings), which is also how saved games move to another browser or
// into the desktop application.
const DATA = "/home/web_user/.local/share/Play Data Files"; // where Play! keeps its files in Emscripten's file system
const card = {
	kept: false,    // the folder is kept in the browser's storage
	why: "",        // why not
	signature: "",  // what was written last
	saving: false, again: false, failed: "",
};
let cardIdle = Promise.resolve();
function errorText(error) { return (error && (error.name || error.message)) || String(error); }
function cardState() {
	let signature = "";
	const walk = (path) => {
		let names;
		try { names = module.FS.readdir(path); } catch(e) { return; }
		for(const name of names) {
			if(name === "." || name === "..") continue;
			const full = path + "/" + name;
			const stat = module.FS.stat(full);
			if(module.FS.isDir(stat.mode)) walk(full);
			else signature += full + ":" + stat.size + ":" + stat.mtime.getTime() + ";";
		}
	};
	walk(DATA);
	return signature;
}
// Two tabs would each write their own picture of the card over the other's. Resolves true
// when this tab has the card to itself (at once, or when the other tab is closed), false
// when the player chose to play here without it.
function cardAlone() {
	if(!check.has.locks || params.get("card") === "0") return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false, button = null;
		const settle = (alone) => {
			if(settled) return;
			settled = true;
			if(button) button.remove();
			resolve(alone);
		};
		navigator.locks.request("rta-memory-card", () => {
			if(settled) return undefined;   // decided meanwhile: given back at once
			settle(true);
			return new Promise(() => {});  // held for as long as this page lives
		}).catch(() => settle(true));
		sleep(700).then(() => {
			if(settled) return;
			setStatus("The game is open in another tab or window of this browser, and two at once would overwrite each other's saved games. Close the other one: this one then goes on by itself.", true);
			progress(null);
			button = document.createElement("button");
			button.type = "button";
			button.className = "big";
			button.textContent = "Play here without keeping saved games";
			button.addEventListener("click", () => settle(false));
			statusElement.after(button);
		});
	});
}
function mountCard(alone = true) {
	return new Promise((resolve) => {
		if(params.get("card") === "0") { card.why = "switched off for this visit"; resolve(); return; } // DEV: an empty card in memory, forgotten afterwards
		if(!alone) { card.why = "another tab of this browser has the memory card"; resolve(); return; }
		if(!check.has.database) { card.why = "this browser gives the page no storage (a private window?)"; resolve(); return; }
		try {
			module.FS.mkdirTree(DATA);
			module.FS.mount(module.IDBFS, {}, DATA);
			module.FS.syncfs(true, (error) => {
				// not read: nothing is written either, or an empty card would replace what is there
				if(error) { card.why = "the browser's storage could not be read (" + errorText(error) + ")"; note("memory card: " + card.why); } else card.kept = true;
				card.signature = cardState();
				resolve();
			});
		} catch(e) {
			card.why = "the browser's storage could not be used (" + errorText(e) + ")";
			note("memory card: " + card.why);
			resolve();
		}
	});
}
function saveCard() {
	if(!module || !card.kept) return;
	if(card.saving) { card.again = true; return; }
	const signature = cardState();
	if(signature === card.signature) return;
	card.saving = true;
	let done;
	cardIdle = new Promise((resolve) => { done = resolve; });
	const finish = (error) => {
		card.saving = false;
		if(error) {
			const first = !card.failed;
			card.failed = errorText(error);
			if(first) {
				note("memory card: could not be written to the browser's storage (" + card.failed + ")");
				notice("Your saved games could NOT be written to this browser's storage (" + (/quota/i.test(card.failed) ? "it is full" : card.failed) +
					"). They last only until this page is closed: Settings → Saved games → Save to a file.", true, 0);
			}
		} else {
			card.signature = signature;
			if(card.failed) { card.failed = ""; notice("Saved games are written to the browser's storage again."); }
			note("memory card: saved in the browser's storage");
		}
		done();
		if(card.again) { card.again = false; saveCard(); }
	};
	try { module.FS.syncfs(false, finish); } catch(e) { finish(e); }
}
// what is not written yet is written; resolves when it is (or after a second and a half)
function flushCard() { saveCard(); return Promise.race([cardIdle, sleep(1500)]); }

// Saved games as a file: a zip of the card's folders, laid out as Play! and the desktop
// application keep them (vfs/mc0/<save>/..., vfs/mc1/...), not compressed.
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for(let n = 0; n < 256; n++) {
		let c = n;
		for(let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();
function crc32(bytes) {
	let c = 0xFFFFFFFF;
	for(let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
	return (c ^ 0xFFFFFFFF) >>> 0;
}
function cardFiles() {
	const files = [];
	const walk = (path) => {
		let names;
		try { names = module.FS.readdir(path); } catch(e) { return; }
		for(const name of names) {
			if(name === "." || name === "..") continue;
			const full = path + "/" + name, stat = module.FS.stat(full);
			if(module.FS.isDir(stat.mode)) walk(full);
			else files.push({ name: full.slice(DATA.length + 1), data: module.FS.readFile(full), time: stat.mtime });
		}
	};
	for(const slot of ["mc0", "mc1"]) walk(DATA + "/vfs/" + slot);
	return files;
}
function zip(files) {
	const parts = [], directory = [], encoder = new TextEncoder();
	let offset = 0, directorySize = 0;
	for(const file of files) {
		const name = encoder.encode(file.name), crc = crc32(file.data), size = file.data.length, t = file.time || new Date();
		const time = (t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1);
		const date = (Math.max(0, t.getFullYear() - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate();
		const local = new DataView(new ArrayBuffer(30)), central = new DataView(new ArrayBuffer(46));
		local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); // names in UTF-8
		local.setUint16(10, time, true); local.setUint16(12, date, true); local.setUint32(14, crc, true);
		local.setUint32(18, size, true); local.setUint32(22, size, true); local.setUint16(26, name.length, true);
		central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true); central.setUint16(8, 0x0800, true);
		central.setUint16(12, time, true); central.setUint16(14, date, true); central.setUint32(16, crc, true);
		central.setUint32(20, size, true); central.setUint32(24, size, true); central.setUint16(28, name.length, true); central.setUint32(42, offset, true);
		parts.push(local.buffer, name, file.data);
		directory.push(central.buffer, name);
		offset += 30 + name.length + size;
		directorySize += 46 + name.length;
	}
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
	end.setUint32(12, directorySize, true); end.setUint32(16, offset, true);
	return new Blob([...parts, ...directory, end.buffer], { type: "application/zip" });
}
// the files of a zip (stored or deflated, as the usual tools write them)
async function unzip(blob) {
	const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
	let end = -1;
	for(let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
		if(view.getUint32(i, true) === 0x06054b50) { end = i; break; }
	}
	if(end < 0) throw new Error("this is not a zip file");
	const count = view.getUint16(end + 10, true), files = [];
	let at = view.getUint32(end + 16, true);
	for(let n = 0; n < count; n++) {
		if(at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error("the zip file is damaged");
		const method = view.getUint16(at + 10, true), packed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
		const nameLength = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true);
		const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
		at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
		if(name.endsWith("/")) continue;
		const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		const raw = bytes.subarray(start, start + packed);
		let data;
		if(method === 0) data = raw.slice();
		else if(method === 8 && typeof DecompressionStream === "function") {
			data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
		} else throw new Error(method === 8 ? "this browser cannot unpack a compressed zip file" : "the zip file is packed in a way this page does not know");
		if(data.length !== size) throw new Error("the zip file is damaged");
		files.push({ name, data });
	}
	return files;
}
// A zip with a memory card in it (vfs/mc0/..., or mc0/..., at any depth: also a zip made of
// the desktop application's folder) is written over the card here. Returns the number of files.
async function cardImport(blob) {
	const files = [];
	for(const file of await unzip(blob)) {
		const name = file.name.replace(/\\/g, "/");
		const match = /(?:^|\/)(mc[01]\/.+)$/.exec(name);
		if(!match || /(^|\/)(__MACOSX|\.DS_Store|\._[^/]*)(\/|$)/.test(name) || name.split("/").includes("..")) continue;
		files.push({ name: "vfs/" + match[1], data: file.data });
	}
	if(!files.length) throw new Error("there is no memory card in it (no folder mc0 or mc1)");
	for(const file of files) {
		const full = DATA + "/" + file.name;
		module.FS.mkdirTree(full.replace(/\/[^/]*$/, ""));
		module.FS.writeFile(full, file.data);
	}
	saveCard();
	return files.length;
}
async function showCard() {
	if(!module) return;
	const files = cardFiles();
	const saves = new Set(files.map((file) => file.name.split("/").slice(1, 3).join("/")));
	const bytes = files.reduce((sum, file) => sum + file.data.length, 0);
	let text = (card.kept ? "Kept in this browser's storage for this site" : "NOT kept (" + card.why + "): what the game saves is lost when the page is closed, unless you save it to a file") +
		": " + saves.size + (saves.size === 1 ? " entry" : " entries") + " on the memory cards, " + Math.ceil(bytes / 1024) + " KB.";
	if(card.failed) text += " The last attempt to write them failed (" + card.failed + ").";
	$("cardExport").disabled = !files.length;
	$("cardSay").textContent = text;
	try {
		const estimate = await navigator.storage.estimate();
		if(estimate.quota) $("cardSay").textContent = text + " The browser lets this site use about " + (estimate.quota >= 2 ** 30 ? (estimate.quota / 2 ** 30).toFixed(0) + " GB" : (estimate.quota / 2 ** 20).toFixed(0) + " MB") + ".";
	} catch(e) { /* not told */ }
}
$("cardExport").addEventListener("click", async () => {
	await flushCard();
	const files = cardFiles();
	if(!files.length) { notice("There is nothing on the memory cards yet.", true); return; }
	const link = document.createElement("a"), day = new Date();
	link.href = URL.createObjectURL(zip(files));
	link.download = "champions-rta-saved-games-" + day.getFullYear() + "-" + String(day.getMonth() + 1).padStart(2, "0") + "-" + String(day.getDate()).padStart(2, "0") + ".zip";
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(link.href), 60000);
	notice("Saved as " + link.download + " (where your browser puts downloads). In the Mac application its two folders belong into ~/Library/Application Support/Play-RTA/player1/vfs.", false, 15000);
});
$("cardImport").addEventListener("click", () => $("cardFile").click());
$("cardFile").addEventListener("change", async (event) => {
	const file = event.target.files[0];
	event.target.value = "";
	if(!file || !module) return;
	try {
		const count = await cardImport(file);
		notice("Loaded: " + count + " files are on the memory card now" + (running ? "; the game sees them the next time it looks at the card." : "."));
	} catch(e) { notice("Not loaded: " + e.message + ".", true, 15000); }
	showCard();
});

// ---- figures ------------------------------------------------------------------------
// A browser runs a page that is not in front (another tab, a covered or minimised window)
// at low priority and lets its timers run late: figures taken then say nothing about the
// build. How long the page was hidden is therefore part of every figure.
let hiddenSince = document.hidden ? performance.now() : null, hiddenTotal = 0;
document.addEventListener("visibilitychange", () => {
	const now = performance.now();
	if(document.hidden) hiddenSince = now;
	else if(hiddenSince !== null) { hiddenTotal += now - hiddenSince; hiddenSince = null; }
});
function info() {
	const result = JSON.parse(module.UTF8ToString(module._rtaInfo()));
	result.hidden_ms = hiddenTotal + (hiddenSince !== null ? performance.now() - hiddenSince : 0);
	return result;
}
function rates(a, b) {
	const seconds = (b.now - a.now) / 1000, frames = b.frames - a.frames;
	const per = (x) => frames ? x / frames : 0;
	return {
		seconds: +seconds.toFixed(2),
		hidden_seconds: +((b.hidden_ms - a.hidden_ms) / 1000).toFixed(2),
		fps: +(frames / seconds).toFixed(2),
		presents_per_second: +((b.presents - a.presents) / seconds).toFixed(2),
		// what the machine's thread needed for a frame: the frame without the wait that holds the rate
		machine_ms_per_frame: +per(((b.now - a.now) * 1000 - (b.wait_us - a.wait_us)) / 1000).toFixed(2),
		video_ms_per_frame: +per((b.video_us - a.video_us) / 1000).toFixed(2),
		gl_calls_per_frame: Math.round(per(b.gl_made - a.gl_made)),
		gl_calls_left_out_per_frame: Math.round(per(b.gl_skipped - a.gl_skipped)),
		block_starts_per_frame: Math.round(per((b.dispatches - a.dispatches) >>> 0)),
		functions_made: b.functions - a.functions,
		function_ms_per_frame: +per((b.function_us - a.function_us) / 1000).toFixed(3),
		draw_calls: b.draw_calls,
		disc_fetches: b.disc_fetches - a.disc_fetches,
	};
}
// Waiting, by a clock in a worker: a browser slows the timers of a page that is not in
// front down to one a second or less, and a test must not depend on being looked at.
const ticker = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 10);"], { type: "text/javascript" })));
const sleepers = [];
ticker.onmessage = () => {
	const now = performance.now();
	for(let i = sleepers.length - 1; i >= 0; i--) {
		if(sleepers[i].until <= now) sleepers.splice(i, 1)[0].resolve();
	}
};
const sleep = (ms) => new Promise((resolve) => sleepers.push({ until: performance.now() + ms, resolve }));

// Keep at most 90 once-per-second readings. No account name, disc path or server
// address is included; the user can export these figures when a slowdown occurs.
const perfHistory = [];
function performanceReport() {
	return {
		format: "champions-web-performance-v1",
		browser: check.browser,
		renderer: check.has.renderer || "unknown",
		worker_webgl: !!check.has.workerWebGl,
		gl_main_thread: !!options.glMain,
		picture_factor: options.factor,
		samples: perfHistory.slice(),
	};
}
function exportPerformance() {
	if(!perfHistory.length) { notice("Run the emulator for a few seconds before collecting performance data.", true); return; }
	const blob = new Blob([JSON.stringify(performanceReport(), null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob), link = document.createElement("a");
	link.href = url;
	link.download = "champions-performance.json";
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60000);
	notice("Saved a performance report from the last " + perfHistory.length + " seconds. No disc image, login or relay address is included.", false, 12000);
}
$("perfExport").addEventListener("click", exportPerformance);

let lastInfo = null, lastRates = null;
setInterval(() => {
	if(!module || !running) return;
	const now = info();
	watch(now);
	if(lastInfo) {
		lastRates = rates(lastInfo, now);
		perfHistory.push({ since_start_seconds: Math.round(performance.now() / 1000), ...lastRates });
		if(perfHistory.length > 90) perfHistory.shift();
		speedElement.textContent = pausedBy ? "paused" : lastRates.fps.toFixed(1) + " frames/s";
		speedElement.title = "machine " + lastRates.machine_ms_per_frame.toFixed(1) + " ms a frame, video " + lastRates.video_ms_per_frame.toFixed(1) + " ms a frame (16.7 is the limit)";
		if(options.report) {
			fetch("/report", { method: "POST", body: JSON.stringify({ kind: "second", level: rta.levelName(), ...lastRates }) }).catch(() => {});
		}
	}
	lastInfo = now;
}, 1000);
// the card is looked at often and written when it has changed: a game saved a moment
// before the page is closed or loaded again should be in the browser's storage by then
sleep(0).then(async function cardLoop() { for(;;) { await sleep(400); saveCard(); } });
if(options.report) {
	// DEV: the test's local server can send this tab on to another address of the same
	// server or have it closed (a tab opened from a command line may close itself as
	// long as it has shown one page only, hence "replace"), so that a run of tests needs
	// one tab.
	setInterval(async () => {
		try {
			const response = await fetch("/command");
			if(response.status !== 200) return;
			const command = await response.json();
			if(command.goto && new URL(command.goto, location.href).origin === location.origin) location.replace(command.goto);
			if(command.close) window.close();
		} catch(e) { /* the server is gone */ }
	}, 2000);
}

// ---- for tests (the developer's console, or a test driving the page) ------------------
const rta = window.rta = {
	B, options, log, checkDisc, fileReader, urlReader, boot,
	info: () => info(),
	last: () => lastRates,
	performanceReport: () => performanceReport(),
	peek: (address, size = 4) => module._rtaPeek(address, size) >>> 0,
	poke: (address, size, value) => module._rtaPoke(address, size, value),
	string: (address, limit = 32) => {
		let text = "";
		for(let i = 0; i < limit; i++) {
			const c = module._rtaPeek(address + i, 1);
			if(!c) break;
			text += String.fromCharCode(c);
		}
		return text;
	},
	levelName: () => rta.string(G_LEVEL_NAME, 16),
	inFrontEnd: () => rta.peek(G_IN_FRONTEND, 1) === 1,
	limiter: (on) => { module.HEAPU32[shared + 6] = on ? 1 : 0; },
	pause: (on) => module._rtaPause(on ? 1 : 0),
	sound: () => audio && { state: audio.context.state, dry: audio.dry, queuedMs: audio.queuedMs, playing: audio.playing },
	// 'name' held for 'hold' frames of the machine, then 'wait' frames of nothing
	tap: async (name, hold = 8, wait = 60) => {
		module._rtaTap(name ? 1 << B[name] : 0, hold, wait);
		while(module._rtaStepsLeft() > 0) await sleep(20);
	},
	wait: (frames) => rta.tap(null, 0, frames),
	measure: async (seconds = 10) => {
		const a = info();
		await sleep(seconds * 1000);
		return rates(a, info());
	},
	// consecutive pictures compared: how many pixels of each differ from the one before
	burst: async (count = 8) => {
		module.HEAPU32[shared + 7] = count;
		for(let i = 0; i < 400 && module.HEAPU32[shared + 7] !== 0; i++) await sleep(25);
		return JSON.parse(module.UTF8ToString(module._rtaBurst()));
	},
	// DEV: the video thread's GL calls over 'seconds': [calls, ms] per frame, by name
	glProfile: async (seconds = 5) => {
		module._rtaGlProfile(1);
		const a = info();
		await sleep(seconds * 1000);
		const b = info();
		const pointer = module._rtaGlProfile(0);
		const result = JSON.parse(module.UTF8ToString(pointer));
		module._free(pointer);
		const frames = b.frames - a.frames;
		const calls = Object.entries(result.calls).map(([name, [n, t]]) => [name, +(n / frames).toFixed(1), +(t / frames).toFixed(3)]).sort((x, y) => y[2] - x[2]);
		return { frames, video_ms_per_frame: +((b.video_us - a.video_us) / 1000 / frames).toFixed(2),
			gl_ms_per_frame: +calls.reduce((sum, c) => sum + c[2], 0).toFixed(2), gl_calls_per_frame: Math.round(calls.reduce((sum, c) => sum + c[1], 0)), calls };
	},
	// DEV: what the machine reads as its pad right now: [buttons, lx, ly, rx, ry, sticks given]
	padWords: () => Array.from(module.HEAPU32.subarray(shared, shared + 6)),
	// DEV: the files Play! keeps (memory cards, settings), with their sizes
	files: () => {
		const list = [];
		const walk = (path) => {
			for(const name of module.FS.readdir(path)) {
				if(name === "." || name === "..") continue;
				const full = path + "/" + name, stat = module.FS.stat(full);
				if(module.FS.isDir(stat.mode)) walk(full); else list.push([full.slice(DATA.length + 1), stat.size]);
			}
		};
		try { walk(DATA); } catch(e) { list.push(["error", String(e)]); }
		return list;
	},
	writeFile: (name, text) => { module.FS.mkdirTree((DATA + "/" + name).replace(/\/[^/]*$/, "")); module.FS.writeFile(DATA + "/" + name, text); },
	removeFile: (name) => { module.FS.unlink(DATA + "/" + name); try { module.FS.rmdir((DATA + "/" + name).replace(/\/[^/]*$/, "")); } catch(e) { /* not empty */ } },
	saveCard: () => saveCard(),
	// DEV: the start-up check's answers, the card's state, why the game is paused ("": it is not),
	// the saved games as a zip and back, the controller and key tables, what the machine reads of them
	check, card, flushCard,
	paused: () => pausedBy,
	zipCard: () => zip(cardFiles()),
	importCard: (blob) => cardImport(blob),
	unzip,
	bindings: () => ({ keys: { ...keyOf }, pads: padMaps, asking }),
	disc: () => ({ url: discUrl, file: discFile && discFile.name, lost: discLost, errors: discErrors }),
	readInput: () => { readInput(); return Array.from(module.HEAPU32.subarray(shared, shared + 6)); },
	// DEV: the left stick at (x, y), 0..255, for exactly 'frames' frames of the machine
	stick: async (x, y, frames) => {
		module._rtaStick(x, y, frames);
		while(module._rtaStepsLeft() > 0) await sleep(20);
	},
	// DEV: 'size' bytes of the game's memory at [pointer] + offset (pointer 0: at offset),
	// taken at every frame for 'frames' frames; resolves to one hexadecimal string per frame
	trace: async (pointer, offset, size, frames, during = null) => {
		module._rtaTrace(pointer, offset, size, frames);
		if(during) await during();
		let text = "";
		for(let i = 0; i < 3000 && !(text = module.UTF8ToString(module._rtaTrace(0, 0, 0, 0))); i++) await sleep(20);
		const rows = [];
		for(let i = 0; i < text.length; i += size * 2) rows.push(text.slice(i, i + size * 2));
		return rows;
	},
	// DEV: the numbers of the 128 KiB pieces of the image read so far, in order
	discPieces: () => {
		const pieces = [];
		for(let i = 0, n; (n = module._RtaWebDiscFetched(i)) >= 0; i++) pieces.push(n);
		return pieces;
	},
	// DEV: A stand-in for a picked file, for testing the player's path without the file
	// dialog: a Blob as large as the image at 'url' that holds the given pieces of it and
	// zeroes everywhere else (the zero pieces are one Blob named again and again, so it
	// costs no memory). Booting it reads through a blob: URL exactly as a picked file is.
	standIn: async (url, pieces) => {
		const PIECE = 0x20000;
		const size = (await urlReader(url)).size;
		const wanted = new Set(pieces);
		const zero = new Blob([new Uint8Array(PIECE)]);
		const parts = [];
		for(let n = 0; n * PIECE < size; n++) {
			const length = Math.min(PIECE, size - n * PIECE);
			if(wanted.has(n)) parts.push(await (await fetch(url, { headers: { Range: "bytes=" + (n * PIECE) + "-" + (n * PIECE + length - 1) } })).blob());
			else parts.push(length === PIECE ? zero : zero.slice(0, length));
		}
		return new File(parts, "stand-in.iso");
	},
	bootFile: (file) => bootFile(file, null),
	// DEV: the picture on the canvas as a PNG, POSTed to /shot/<name> of the local test
	// server (which keeps it outside the repository's tracked files)
	shot: async (name) => {
		module._rtaShot(1);
		let pixels = 0;
		for(let i = 0; i < 200 && !(pixels = module._rtaShot(0)); i++) await sleep(25);
		if(!pixels) throw new Error("no picture was handed over");
		const width = canvas.width, height = canvas.height;
		const image = new ImageData(width, height);
		for(let y = 0; y < height; y++) {
			image.data.set(module.HEAPU8.subarray(pixels + (height - 1 - y) * width * 4, pixels + (height - y) * width * 4), y * width * 4);
		}
		for(let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
		const copy = new OffscreenCanvas(width, height);
		copy.getContext("2d").putImageData(image, 0, 0);
		const blob = await copy.convertToBlob({ type: "image/png" });
		const response = await fetch("/shot/" + encodeURIComponent(name), { method: "POST", body: blob });
		return { name, width, height, bytes: blob.size, status: response.status };
	},
	// DEV (a build with -DPROFILE=ON): the machine thread's milliseconds per frame by zone
	zones: async (seconds = 5) => {
		const read = () => [info(), JSON.parse(module.UTF8ToString(module._rtaZones()))];
		const [a, za] = read();
		await sleep(seconds * 1000);
		const [b, zb] = read();
		const frames = b.frames - a.frames, result = { frames, fps: +(frames / ((b.now - a.now) / 1000)).toFixed(2) };
		for(const name in zb) result[name] = +(((zb[name] - (za[name] || 0)) / 1e6) / frames).toFixed(2);
		return result;
	},
	// DEV: the GL calls that make up a frame do nothing from here on (reload afterwards)
	glNull: () => module._rtaGlProfile(2),
	// power-on to the title screen's menu: cross through the memory-card question and the logos
	toTitle: async () => {
		await rta.wait(120);
		for(let i = 0; i < 80; i++) {
			if(rta.inFrontEnd() && rta.levelName() === "intro") break;
			await rta.tap("cross", 6, 40);
		}
		if(!(rta.inFrontEnd() && rta.levelName() === "intro")) throw new Error("the front end did not come up");
		await rta.wait(420); // the title's own fade-in
	},
	// on from the title: a new offline game into the first level (local/play-out/tohub.py)
	toHub: async (settle = 300) => {
		for(const frames of [90, 90, 90, 90, 200, 120, 120]) await rta.tap("cross", 8, frames);
		for(let i = 0; i < 20; i++) await rta.tap("right", 4, 6);
		await rta.wait(20);
		await rta.tap("cross", 8, 120);
		for(let i = 0; i < 3; i++) await rta.tap("cross", 4, 8);
		for(let i = 0; i < 6; i++) await rta.tap("down", 4, 8);
		for(let i = 0; i < 5; i++) await rta.tap("right", 4, 8);
		await rta.tap("cross", 8, 60);
		for(let i = 0; i < 120 && rta.levelName() !== "hub"; i++) await rta.wait(30);
		if(rta.levelName() !== "hub") throw new Error("the first level was not reached (level '" + rta.levelName() + "')");
		if(settle) await rta.wait(settle);
	},
	// online play: what the page shows; start(0 lobby | 1 host | 2 join, code); name(text);
	// DEV: round trips to the relay in milliseconds, and the link taken down
	online: {
		state: () => onlineState(),
		players: () => onlinePlayers(onlineState()),
		link: () => ({ relay: !!online.relay, signin: online.signinLoaded, welcomed: online.welcomed, notice: online.notice, rtt: online.rtt.slice(), awake: !!wakeLock }),
		start: (mode, code = "") => onlineStart(mode, code),
		name: (text) => module.UTF8ToString(onlineCall("_rtaOnlineName", text)),
		stop: () => module._rtaOnlineStop(),
		forget: () => module._rtaOnlineForget(),
		pings: async (count = 50, gap = 20) => {
			const times = [];
			for(let i = 0; i < count; i++) { const ms = await relayPing(); if(ms !== null) times.push(+ms.toFixed(3)); await sleep(gap); }
			return times;
		},
		drop: () => online.socket && online.socket.close(),
	},
	state: "loading",
};

async function report(kind, data) {
	note(kind + ": " + JSON.stringify(data));
	if(options.report) await fetch("/report", { method: "POST", body: JSON.stringify({ kind, ...data }) }).catch(() => {});
}

// what the sound did over an interval: times the ring ran dry, and what was queued at the end
async function soundOver(run) {
	const before = audio ? audio.dry : 0;
	const result = await run();
	if(audio) result.sound = { state: audio.context.state, ran_dry: audio.dry - before, queued_ms: audio.queuedMs, playing: !!audio.playing };
	return result;
}

async function automatic() {
	try {
		// a browser started for tests with --autoplay-policy=no-user-gesture-required lets
		// the sound start without a person; otherwise it stays asleep and is not judged
		startSound();
		await report("start", { browser: navigator.userAgent, canvas: [canvas.width, canvas.height], factor: options.factor,
			gl: options.glMain ? "main thread" : "own canvas", sound: options.sound, patches: options.patches, visible: document.visibilityState });
		rta.state = "to title";
		await rta.toTitle();
		rta.state = "title";
		await report("title", await soundOver(() => rta.measure(10)));
		await report("title-burst", { burst: await rta.burst(8) });
		if(options.auto === "trace") {
			// For comparing arithmetic with the desktop application: the player's position
			// (x, y, z as the raw bytes of three floats) at every frame, first for six
			// seconds from arriving in the level without any input, then while the left
			// stick is held fully right for exactly 60 frames.
			const PLAYER_OBJECT = 0x4d8af0 + 0x43d8;
			rta.state = "to hub";
			await rta.toHub(0);
			rta.state = "trace";
			const runs = (rows) => { const out = []; for(const row of rows) { if(out.length && out[out.length - 1][0] === row) out[out.length - 1][1]++; else out.push([row, 1]); } return out; };
			await report("trace-arrival", { positions: runs(await rta.trace(PLAYER_OBJECT, 0x10, 12, 360)) });
			// place=XXXXXXXX,YYYYYYYY (the bits of two floats): the player is put at that
			// x and y first, so that two builds start the walk from the same bits wherever
			// the game happened to stand the character (where it does depends on how many
			// frames the menus took)
			if(params.get("place")) {
				const [x, y] = params.get("place").split(",").map((text) => parseInt(text, 16));
				const object = rta.peek(PLAYER_OBJECT);
				rta.poke(object + 0x10, 4, x);
				rta.poke(object + 0x14, 4, y);
				await rta.wait(60);
			}
			await report("trace-move", { positions: runs(await rta.trace(PLAYER_OBJECT, 0x10, 12, 110, () => rta.stick(255, 128, 60))) });
		}
		if(options.auto === "hub") {
			rta.state = "to hub";
			await rta.toHub();
			rta.state = "hub";
			// the first seconds in a level: its code is still being translated and the
			// browser is still making the fast version of what was translated
			await report("hub-arrival", await rta.measure(10));
			await report("hub", await soundOver(() => rta.measure(15)));
			await report("hub-burst", { burst: await rta.burst(8) });
			if(params.get("shot")) await report("shot", await rta.shot(params.get("shot")));
			if(params.get("glprofile")) await report("gl-profile", await rta.glProfile(5));
			rta.limiter(false);
			await sleep(2000);
			await report("hub-unlimited", await rta.measure(10));
			rta.limiter(true);
		}
		rta.state = "done";
		await report("done", {});
	} catch(e) {
		rta.state = "failed: " + e.message;
		await report("failed", { error: e.message });
	}
}

// ---- start --------------------------------------------------------------------------
// The emulator's program is fetched here rather than by its loader, so that the page can
// show how far it is. The compiler gets the response itself (a browser keeps the compiled
// code of such a response for the next visit); a copy is read beside it for the count.
let programFailed = null;
function loadProgram(imports, receive) {
	(async () => {
		const address = new URL("Play.wasm", import.meta.url);
		let result;
		try {
			const response = await fetch(address, { credentials: "same-origin" });
			if(!response.ok) throw new Error("Play.wasm: the server answered " + response.status);
			// sent compressed, the length the server names is not the length that is read: then only what has come is shown
			const total = response.headers.get("content-encoding") ? 0 : parseInt(response.headers.get("content-length"), 10) || 0;
			const counted = response.clone().body.getReader();
			(async () => {
				for(let seen = 0; ;) {
					const { done, value } = await counted.read();
					if(done) break;
					seen += value.length;
					if(!module) { statusElement.textContent = "Loading the emulator… " + (seen / 1048576).toFixed(1) + " MB"; progress(total ? seen / total : "busy"); }
				}
				if(!module) { statusElement.textContent = "Starting the emulator…"; progress("busy"); }
			})().catch(() => {});
			result = await WebAssembly.instantiateStreaming(response, imports);
		} catch(e) {
			if(e instanceof WebAssembly.CompileError || e instanceof WebAssembly.LinkError || e instanceof RangeError) throw e;
			note("emulator: read as a whole (" + e + ")"); // a server that does not name the file's type, or a connection that broke
			result = await WebAssembly.instantiate(await (await fetch(address, { credentials: "same-origin" })).arrayBuffer(), imports);
		}
		receive(result.instance, result.module);
	})().catch((e) => programFailed(e));
	return {};
}
// Why the emulator did not come up, in words for the person in front of it.
function startFailure(e) {
	const text = String((e && e.message) || e);
	progress(null);
	note("not started: " + text);
	if(e instanceof RangeError || /out of memory|allocat/i.test(text)) {
		setStatus("The browser could not give the page the memory the emulator asks for (1 GB in one piece). Phones, tablets and 32-bit browsers often cannot; with many tabs open a computer may not either: close some and load the page again. This is " + check.browser + ".", true);
	} else if(e instanceof WebAssembly.CompileError || e instanceof WebAssembly.LinkError) {
		setStatus("This browser cannot run the emulator's program (" + text + "). Use a current Chrome, Edge, Brave, Firefox or Safari on a computer. This is " + check.browser + ".", true);
	} else setStatus("The emulator could not be started (" + text + "). Check the connection and load the page again. This is " + check.browser + ".", true);
}

async function start() {
	// What this browser lacks is found and said by the start-up check (index.html); with
	// anything missing that the page cannot do without, nothing more is loaded.
	check.started = true;
	if(check.done) await check.done;
	performance.mark("rta-checked"); // marks for whoever times a start: checked, program (the emulator is in), ready, boot
	if(check.missing.length) { note("not started: " + check.missing.join(" | ")); return; }
	if(!self.crossOriginIsolated) {
		setStatus("This page has to be served with the headers Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp (the emulator runs on several threads).", true);
		return;
	}
	// no WebGL 2 on a thread's own canvas here: the context is made on this thread, as Play! itself does it (slower)
	if(check.has.workerWebGl === false && check.has.mainWebGl) options.glMain = true;
	// The canvas: 4:3, as many pixels as the picture can take up on this screen (in full
	// screen: the window may be small now), but not more than 896 lines (the console's 448
	// twice; a larger canvas costs speed out of proportion - see docs/issues/browser-build.md)
	// and not fewer than 480. Its size is fixed from here on: the video thread owns it.
	const scale = Math.min(window.devicePixelRatio || 1, 2);
	const stage = $("stage").getBoundingClientRect();
	const wide = Math.max(screen.width, screen.height) || stage.width, high = Math.min(screen.width, screen.height) || stage.height;
	let height = Math.max(480, Math.min(896, Math.floor(Math.max(Math.min(stage.height, stage.width * 3 / 4), Math.min(high, wide * 3 / 4)) * scale)));
	if(params.get("canvas")) height = parseInt(params.get("canvas"), 10);
	canvas.height = height;
	canvas.width = Math.round(height * 4 / 3);

	setStatus("Loading the emulator…");
	progress("busy");
	const loaded = Play({
		print: (text) => note("emulator: " + text),
		printErr: (text) => note("emulator (error): " + text),
		instantiateWasm: loadProgram,
		onAbort: (what) => { note("emulator: aborted (" + what + ")"); if(running) notice("The emulator has stopped (" + what + "). Load the page again; what the game had saved is kept.", true, 0); },
	});
	try { module = await Promise.race([loaded, new Promise((resolve, reject) => { programFailed = reject; })]); } catch(e) { startFailure(e); return; }
	module.rtaDiscRead = discReadForMachine;
	performance.mark("rta-program");
	setStatus("Reading the saved games…");
	await mountCard(await cardAlone());
	setStatus("Starting the emulator…");
	progress("busy");
	const goesOnline = await onlineConfig();

	if(options.patches) {
		try {
			const [patchText, sectionText] = await Promise.all([
				fetch("SLUS-20973_4028A55F.pnach").then((r) => { if(!r.ok) throw new Error("patch file " + r.status); return r.text(); }),
				fetch("sections.txt").then((r) => { if(!r.ok) throw new Error("section list " + r.status); return r.text(); }),
			]);
			const a = writeString(patchText), b = writeString(options.allSections ? "*" : sectionText);
			const words = module._rtaSetPatches(a, b, options.display ? 1 : 0);
			module._free(a);
			module._free(b);
			note("patches: " + words + " words");
			if(words < 0) { setStatus("The patch file could not be understood: not started."); return; }
			if(goesOnline && online.signin) {
				// what takes the game past its sign-in step; without it the page plays offline only
				const response = await fetch(online.signin);
				if(response.ok) {
					const c = writeString(await response.text());
					online.signinLoaded = module._rtaAddPatches(c) > 0;
					module._free(c);
				}
				note("online: sign-in patch " + (online.signinLoaded ? "loaded" : "NOT loaded: the game cannot go online"));
			}
		} catch(e) {
			setStatus("The patch file could not be loaded (" + e.message + "): not started.");
			return;
		}
	} else {
		const empty = writeString("");
		module._rtaSetPatches(empty, empty, options.display ? 1 : 0);
		module._free(empty);
	}

	if(goesOnline) {
		// before the machine is made: it then gets its Ethernet adaptor's cable, the network
		// setting on its memory card and the online driver
		const host = new URL(online.relay).host;
		onlineCall("_rtaOnlineSetup", host, "of this site (" + host + ")", DATA);
		module.rtaNetWake = () => { if(module._rtaNetWoke()) relayConnect(); relayDrain(); };
		online.buffer = module._malloc(RELAY_BUFFER);
	}
	module._rtaInit(canvas.width, canvas.height, options.factor, options.glMain ? 0 : 1, options.sound ? 1 : 0, 0);
	for(let i = 0; i < 1000 && !module._rtaReady(); i++) await sleep(20);
	if(!module._rtaReady()) {
		progress(null);
		setStatus("The emulator's threads did not come up. Load the page again; if it stays like this, this browser cannot run it (" + check.browser + (check.has.renderer ? ", drawing with " + check.has.renderer : "") + ").", true);
		return;
	}
	shared = module._rtaShared() >> 2;
	module.HEAPU32[shared + 6] = options.limit ? 1 : 0;
	// Chromium on Windows benefits from keeping the 8 ms timer active for frame
	// pacing. rAF and that timer often fire in the same few milliseconds: only
	// sample the controller once, while key events still update input immediately.
	let lastInputPoll = -Infinity;
	const pollInput = () => {
		const now = performance.now();
		if(now - lastInputPoll < 7) return;
		lastInputPoll = now;
		readInput();
	};
	const frame = () => { pollInput(); requestAnimationFrame(frame); };
	requestAnimationFrame(frame);
	setInterval(pollInput, 8); // also when the page is not being painted
	rta.state = "ready";
	performance.mark("rta-ready");
	showMute();
	if(goesOnline) {
		$("onlineButton").hidden = false;
		relayConnect(); // so that the cable is in when the game looks for it
		onlineLoop();
	}

	if(options.disc) {
		// DEV: a disc image served by the developer's own local server
		const url = new URL(options.disc, location.href);
		if(url.origin !== location.origin) { setStatus("disc= must be a URL of this server.", true); return; }
		if(await boot(await urlReader(url.href), url.href, "disc.iso") && options.auto) automatic();
		return;
	}
	const handle = check.has.filePicker === false ? null : await remembered("disc");
	progress(null);
	if(handle) {
		$("resume").textContent = "Continue with " + handle.name;
		$("resume").hidden = false;
		$("choose").textContent = "Choose another disc image…";
		showDisc(handle.name, true);
	}
	$("choose").hidden = false;
	$("hints").textContent = "Sound starts with your first click. A game controller is in use as soon as you press a button on it; keys and buttons are under Controls." +
		(card.kept ? " Saved games stay in this browser; Settings saves them to a file." : " Saved games are NOT kept here (" + card.why + "): Settings saves them to a file.");
	$("hints").hidden = false;
	setStatus(handle ? "Ready." : "Ready. Choose your disc image to start.");
}

start().catch(startFailure);
window.addEventListener("pagehide", saveCard);
