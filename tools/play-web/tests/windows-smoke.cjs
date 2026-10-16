// Windows Chromium start-up smoke test. Runs against the freshly built web assets.
// No game ISO is needed; this checks browser capabilities, WebAssembly worker startup
// and the page's diagnostics, not gameplay FPS or multiplayer synchronization.
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "../../..");
const site = path.join(root, "local", "play-web-site");
const url = "http://127.0.0.1:8973/";
const reportPath = path.join(root, "local", "ci-windows-report.jsonl");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ready() {
	for(let i = 0; i < 90; i++) {
		try {
			const status = await new Promise((resolve, reject) => {
				http.get(url, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
			});
			if(status === 200) return;
		} catch(e) { /* server not started yet */ }
		await sleep(500);
	}
	throw new Error("The local test server did not start");
}

async function checkWindowsReport() {
	const data = Buffer.from(JSON.stringify({ kind: "windows-browser-smoke", fps: 60 }));
	const status = await new Promise((resolve, reject) => {
		const request = http.request(url + "report", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Content-Length": data.length },
		}, (response) => { response.resume(); resolve(response.statusCode); });
		request.on("error", reject);
		request.end(data);
	});
	assert.equal(status, 204, "Local report endpoint must accept JSON on Windows");
	const rows = fs.readFileSync(reportPath, "utf8").trim().split("\n");
	assert.ok(rows.some((row) => JSON.parse(row).kind === "windows-browser-smoke"),
		"Local Windows server did not persist the performance sample");
	console.log("Windows local report endpoint: OK");
}

async function smoke(channel) {
	const browser = await chromium.launch({
		channel, headless: true,
		args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
	});
	try {
		const page = await browser.newPage();
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
		await page.waitForFunction(() => window.rta && window.rta.state === "ready",
			null, { timeout: 90000 });
		const result = await page.evaluate(() => {
			const state = window.rta;
			return {
				check: { browser: state.check.browser, missing: state.check.missing },
				info: state.info(),
				report: state.performanceReport(),
				exportPresent: !!document.getElementById("perfExport"),
			};
		});
		assert.equal(result.check.missing.length, 0, "Required browser capabilities are missing");
		assert.equal(result.info.ready, 1, "Play! workers did not initialize");
		assert.equal(result.report.format, "champions-web-performance-v1");
		assert.equal(result.exportPresent, true, "Performance export control is missing");
		assert.equal(result.report.browser, result.check.browser);
		assert.equal(errors.length, 0, "Page JavaScript errors: " + errors.join("; "));
		console.log(channel + ": READY, workers and diagnostics OK (" + result.check.browser + ")");
	} finally {
		await browser.close();
	}
}

(async () => {
	const server = spawn("python", ["tools/play-web/serve.py", "--site", site, "--report", reportPath], {
		cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
	});
	let stderr = "";
	server.stderr.on("data", (chunk) => { stderr += String(chunk); });
	try {
		await ready();
		await checkWindowsReport();
		for(const channel of ["chrome", "msedge"]) await smoke(channel);
	} finally {
		server.kill();
		if(stderr) console.log("Server stderr:", stderr.slice(-1200));
	}
})().catch((e) => { console.error(e); process.exitCode = 1; });
