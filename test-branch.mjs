// Run with the path to an installed pi-coding-agent package. No external requests.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [, , piRoot] = process.argv;
assert.ok(piRoot, "Pass the absolute path to an installed pi-coding-agent package");
const extension = fileURLToPath(new URL("./index.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pi-selector-branch-"));
process.env.HOME = process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
delete process.env.PI_SUBAGENT_AGENT_ID;

const sent = [];
const server = createServer(async (req, res) => {
	let body = "";
	for await (const part of req) body += part;
	const payload = JSON.parse(body);
	sent.push(payload);
	const chunk = {
		id: "fixture", object: "chat.completion.chunk", created: 1, model: payload.model,
		choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
	};
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
	const sdk = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
	mkdirSync(join(dir, "agents"));
	writeFileSync(join(dir, "agents", "Fast.md"),
		"---\ntype: main\ntools: [read]\nmodel:\n  id: fixture-selector/original\n  thinking: high\n---\n\nFast_FIXTURE_BODY\n");
	writeFileSync(join(dir, "agents", "Orchestrate.md"),
		"---\ntype: main\ntools: [grep]\n---\n\nOrchestrate_FIXTURE_BODY\n");
	writeFileSync(join(dir, "agents", "Empty.md"), "---\ntype: main\ntools: [read]\n---\n");
	writeFileSync(join(dir, "settings.json"), JSON.stringify({
		packages: [extension], defaultTools: ["read", "grep"], cacheWarming: "off",
	}));
	const provider = "fixture-selector", api = "openai-completions";
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
	const models = ["original", "manual"].map((id) => ({
		id, name: id, provider, api, baseUrl, input: ["text"], reasoning: true,
		contextWindow: 100_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
	const runtime = await sdk.ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
	runtime.registerProvider(provider, { api, baseUrl, apiKey: "fixture-only", models });
	await runtime.setRuntimeApiKey(provider, "fixture-only");

	async function start(sessionManager = sdk.SessionManager.inMemory(dir)) {
		const settingsManager = sdk.SettingsManager.create(dir, dir, { projectTrusted: false });
		const resourceLoader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager });
		await resourceLoader.reload();
		const { session, extensionsResult } = await sdk.createAgentSession({
			cwd: dir, agentDir: dir, settingsManager, resourceLoader, sessionManager, modelRuntime: runtime,
			...(sessionManager.getEntries().length === 0 ? { model: models[0] } : {}),
		});
		assert.deepEqual(extensionsResult.errors, []);
		await session.bindExtensions({ mode: "print" });
		return session;
	}

	async function check(session, label, preset, tools) {
		const count = sent.length;
		await session.prompt(label);
		assert.equal(sent.length, count + 1, label);
		const payload = sent.at(-1);
		const prompt = payload.messages.filter(({ role }) => ["system", "developer"].includes(role))
			.map(({ content }) => content).join("\n");
		assert.equal(prompt.match(/(Fast|Orchestrate)_FIXTURE_BODY/)?.[1], preset, `${label}: preset`);
		assert.deepEqual((payload.tools ?? []).map((tool) => tool.function.name).sort(), tools, `${label}: tools`);
	}

	let session = await start();
	await check(session, "Unselected branch", undefined, ["grep", "read"]);
	const unselected = session.sessionManager.getLeafId();
	await session.prompt("/agent Fast");
	assert.equal(session.model.id, "original");
	assert.equal(session.thinkingLevel, "high");
	await session.setModel(models[1]);
	session.setThinkingLevel("low");
	await check(session, "Fast branch", "Fast", ["read"]);
	const fast = session.sessionManager.getLeafId();
	await session.prompt("/agent Orchestrate");
	await check(session, "Orchestrate branch", "Orchestrate", ["grep"]);
	const orchestrate = session.sessionManager.getLeafId();

	for (const [leaf, label, preset, tools] of [
		[fast, "Tree back to Fast", "Fast", ["read"]],
		[orchestrate, "Tree forward to Orchestrate", "Orchestrate", ["grep"]],
		[unselected, "Tree back before any selection", undefined, ["grep", "read"]],
	]) {
		await session.navigateTree(leaf);
		assert.equal(session.model.id, "manual");
		assert.equal(session.thinkingLevel, "low");
		await check(session, label, preset, tools);
	}
	await session.navigateTree(fast);
	const manager = session.sessionManager;
	session.dispose();
	session = await start(manager);
	assert.equal(session.model.id, "manual");
	assert.equal(session.thinkingLevel, "low");
	await check(session, "Resume Fast despite a later off-branch selection", "Fast", ["read"]);
	// Pi already persisted this manual tool change after a preset. Restoring
	// selector state must not reapply the preset's original whitelist.
	session.setActiveToolsByName(["grep", "read"]);
	await check(session, "Manual tool change while Fast is selected", "Fast", ["grep", "read"]);
	const changed = session.sessionManager.getLeafId();
	await session.navigateTree(orchestrate);
	await session.navigateTree(changed);
	await check(session, "Tree preserves manual tool change", "Fast", ["grep", "read"]);
	session.dispose();
	session = await start(manager);
	await check(session, "Resume preserves manual tool change", "Fast", ["grep", "read"]);
	await session.prompt("/agent none");
	await check(session, "Cleared selection", undefined, ["grep", "read"]);
	session.dispose();

	session = await start();
	await check(session, "Before selecting a preset with no following turn", undefined, ["grep", "read"]);
	await session.prompt("/agent Fast");
	const pending = session.sessionManager;
	session.dispose();
	session = await start(pending);
	await check(session, "Resume an unapplied preset", "Fast", ["read"]);
	session.dispose();

	session = await start();
	await check(session, "Before selecting an empty preset", undefined, ["grep", "read"]);
	await session.prompt("/agent Empty");
	assert.deepEqual(session.getActiveToolNames(), ["read"]);
	session.setActiveToolsByName(["grep", "read"]);
	await check(session, "Manual choice needs no new tool delta", undefined, ["grep", "read"]);
	const unchanged = session.sessionManager;
	session.dispose();
	session = await start(unchanged);
	await check(session, "Resume preserves manual choice without a delta", undefined, ["grep", "read"]);
	session.dispose();
	console.log("PASS: branch-local presets, persisted tool choice, model/thinking, no preset, and pending selection");
} finally {
	server.closeAllConnections();
	server.close();
	rmSync(dir, { recursive: true, force: true });
}
