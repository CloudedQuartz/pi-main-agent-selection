/**
 * Agent Selection Extension — configurable shortcut, coloured footer, session persistence.
 * Config: ~/.pi/agent/extensions/main-agent-selection/config.json
 * Default shortcut: Alt+A (Ctrl+Shift+A is indistinguishable from Ctrl+A in legacy VT).
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { env } from "node:process";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { type Component, type SelectItem, SelectList } from "@earendil-works/pi-tui";

// ── Constants & types ──

const EXT_DIR = "main-agent-selection";
const STATE_ENTRY = "main-agent-selection";
const NO_AGENT_VALUE = "__none__";
const RESET = "\x1b[0m";
const THINKING_VALUES = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);
const FM_KEYS = new Set(["description", "type", "model", "tools", "agents"]);
const MODEL_KEYS = new Set(["id", "thinking"]);

interface FooterCfg {
	enabled: boolean;
	statusKey: string;
	prefix: string;
	colors: Record<string, string>;
	noneColor: string;
}
interface Cfg {
	enabled: boolean;
	command: string;
	shortcut: string | null;
	footer: FooterCfg;
}
const DEFAULT_CFG: Cfg = {
	enabled: true,
	command: "agent",
	shortcut: "alt+a",
	footer: {
		enabled: true,
		statusKey: "current-agent",
		prefix: "Agent:",
		colors: {},
		noneColor: "#6B7280",
	},
};
interface AgentDef {
	id: string;
	description: string;
	prompt: string;
	model?: { id?: string; thinking?: string };
	tools?: readonly string[];
}
type StatusCtx = {
	hasUI?: boolean;
	ui: { setStatus(key: string, text: string | undefined): void };
};
interface MainCtx extends StatusCtx {
	sessionManager: { getEntries(): readonly unknown[] };
	ui: StatusCtx["ui"] & {
		custom?<T>(
			factory: (
				tui: { requestRender(): void },
				theme: { fg(color: string, text: string): string },
				keybindings: unknown,
				done: (result: T) => void,
			) => Component | Promise<Component>,
		): Promise<T>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
	modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
	};
}

// ── Module state ──

let currentAgentId: string | null = null;
let activeAgentPrompt: string | undefined;
let baselineActiveTools: string[] | undefined;
let footerCtx: StatusCtx | undefined;

// ── Small helpers ──

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isEnoent(e: unknown): boolean {
	return isRecord(e) && (e as Record<string, unknown>).code === "ENOENT";
}
function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
function suiteDir(sub: string): string {
	const d = env.PI_AGENT_SUITE_DIR;
	const base = d?.length
		? d === "~"
			? homedir()
			: d.startsWith("~/")
				? join(homedir(), d.slice(2))
				: d
		: join(getAgentDir(), "agent-suite");
	return join(base, sub);
}

// ── Config ──

async function readConfig(): Promise<Cfg> {
	let raw: string;
	try {
		raw = await readFile(
			join(getAgentDir(), "extensions", EXT_DIR, "config.json"),
			"utf8",
		);
	} catch {
		return DEFAULT_CFG;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return DEFAULT_CFG;
	}
	if (!isRecord(parsed)) return DEFAULT_CFG;
	const p = parsed;
	const enabled =
		typeof p.enabled === "boolean" ? p.enabled : DEFAULT_CFG.enabled;
	const command =
		typeof p.command === "string" && p.command.trim()
			? p.command.trim()
			: DEFAULT_CFG.command;
	const shortcut =
		p.shortcut === null
			? null
			: typeof p.shortcut === "string" && p.shortcut.trim()
				? p.shortcut.trim()
				: DEFAULT_CFG.shortcut;
	let footer = DEFAULT_CFG.footer;
	if (isRecord(p.footer)) {
		const f = p.footer;
		const clean = (s: string) =>
			s
				.replace(/[\r\n\t]/g, " ")
				.replace(/ +/g, " ")
				.trim();
		footer = {
			enabled:
				typeof f.enabled === "boolean" ? f.enabled : DEFAULT_CFG.footer.enabled,
			statusKey:
				typeof f.statusKey === "string" && f.statusKey.trim()
					? f.statusKey.trim()
					: DEFAULT_CFG.footer.statusKey,
			prefix:
				typeof f.prefix === "string"
					? clean(f.prefix)
					: DEFAULT_CFG.footer.prefix,
			colors: isRecord(f.colors)
				? Object.fromEntries(
						Object.entries(f.colors).filter(
							(e): e is [string, string] =>
								typeof e[1] === "string" && /^#[\da-f]{6}$/i.test(e[1]),
						),
					)
				: { ...DEFAULT_CFG.footer.colors },
			noneColor:
				typeof f.noneColor === "string" && /^#[\da-f]{6}$/i.test(f.noneColor)
					? f.noneColor
					: DEFAULT_CFG.footer.noneColor,
		};
	}
	return { enabled, command, shortcut, footer };
}

// ── Agent definitions ──

async function loadAgentDefs(): Promise<AgentDef[]> {
	const dir = await findAgentsDir();
	if (!dir) return [];
	const entries = [...(await readdir(dir))]
		.sort()
		.filter((e) => e.endsWith(".md"));
	const agents = await Promise.all(entries.map((e) => parseAgentFile(dir, e)));
	return agents.filter((a): a is AgentDef => a !== undefined);
}

async function findAgentsDir(): Promise<string | undefined> {
	const suitePath = join(suiteDir("agent-selection"), "agents");
	try {
		await readdir(suitePath);
		return suitePath;
	} catch (e) {
		if (!isEnoent(e))
			throw new Error(`failed to read suite agents dir: ${errMsg(e)}`);
	}
	const legacyPath = join(getAgentDir(), "agents");
	try {
		await readdir(legacyPath);
		return legacyPath;
	} catch {
		return undefined;
	}
}

async function parseAgentFile(
	dir: string,
	name: string,
): Promise<AgentDef | undefined> {
	let content: string;
	try {
		content = await readFile(join(dir, name), "utf8");
	} catch {
		return undefined;
	}
	const { frontmatter: fm, body } = parseFrontmatter(content);
	if (!isRecord(fm) || !Object.keys(fm).every((k) => FM_KEYS.has(k)))
		return undefined;
	const type = fm.type ?? "main";
	if (type !== "main" && type !== "both") return undefined;
	if (fm.description !== undefined && typeof fm.description !== "string")
		return undefined;
	const model = parseModel(fm.model);
	if (model === false) return undefined;
	const tools = parseStrList(fm.tools);
	if (tools === false) return undefined;
	return {
		id: basename(name, ".md"),
		description: (fm.description as string) ?? "",
		prompt: body.trim(),
		...(model !== undefined ? { model } : {}),
		...(tools !== undefined ? { tools } : {}),
	};
}

function parseModel(value: unknown): AgentDef["model"] | false | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !Object.keys(value).every((k) => MODEL_KEYS.has(k)))
		return false;
	const v = value;
	if (
		v.id !== undefined &&
		!(
			typeof v.id === "string" &&
			v.id.includes("/") &&
			!v.id.startsWith("/") &&
			!v.id.endsWith("/")
		)
	)
		return false;
	const validThinking =
		typeof v.thinking === "string" && THINKING_VALUES.has(v.thinking);
	if (v.thinking !== undefined && !validThinking) return false;
	return {
		...(typeof v.id === "string" ? { id: v.id } : {}),
		...(validThinking && typeof v.thinking === "string"
			? { thinking: v.thinking }
			: {}),
	};
}

function parseStrList(value: unknown): readonly string[] | false | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return false;
	const seen = new Set<string>(),
		result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !item.trim() || seen.has(item))
			return false;
		seen.add(item);
		result.push(item);
	}
	return result;
}

// ── Tool policy ──

function resolveToolPolicy(
	patterns: readonly string[],
	available: readonly string[],
): { tools: string[] } | { issue: string } {
	const resolved: string[] = [],
		seen = new Set<string>();
	for (const pattern of patterns) {
		if (/^\*+$/.test(pattern))
			return { issue: "full wildcard * is not allowed" };
		const matches = pattern.includes("*")
			? available.filter((t) =>
					new RegExp(
						`^${pattern
							.split("*")
							.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
							.join(".*")}$`,
					).test(t),
				)
			: available.includes(pattern)
				? [pattern]
				: [];
		if (matches.length === 0)
			return {
				issue: `tool pattern ${pattern} did not match any available tool`,
			};
		for (const tool of matches)
			if (!seen.has(tool)) {
				seen.add(tool);
				resolved.push(tool);
			}
	}
	return { tools: resolved };
}

// ── Colour helpers ──

function formatStatus(agentId: string | null, cfg: FooterCfg): string {
	const label = (agentId ?? "none")
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
	const color = agentColor(agentId, cfg);
	return `${fg(color, cfg.prefix)}${fg(color, label)}`;
}

function agentColor(id: string | null, cfg: FooterCfg): string {
	if (id === null) return cfg.noneColor;
	if (cfg.colors[id] !== undefined) return cfg.colors[id];
	const lower = id.toLowerCase();
	for (const [k, v] of Object.entries(cfg.colors))
		if (k.toLowerCase() === lower) return v;
	return hashColor(id);
}

function hashColor(text: string): string {
	const d = createHash("sha256").update(text).digest();
	return hslToHex(((d[0] / 255) * 360) | 0, 66 + (d[1] % 10), 62 + (d[2] % 10));
}

function fg(hex: string, text: string): string {
	const n = parseInt(hex.slice(1), 16);
	return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m${text}${RESET}`;
}

function hslToHex(h: number, s: number, l: number): string {
	const sf = s / 100,
		lf = l / 100,
		c = (1 - Math.abs(2 * lf - 1)) * sf;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
		m = lf - c / 2;
	const [r, g, b] =
		h < 60
			? [c, x, 0]
			: h < 120
				? [x, c, 0]
				: h < 180
					? [0, c, x]
					: h < 240
						? [0, x, c]
						: h < 300
							? [x, 0, c]
							: [c, 0, x];
	return `#${[r, g, b]
		.map((v) =>
			Math.round((v + m) * 255)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

// ── Active agent management ──

function setActiveAgent(
	pi: ExtensionAPI,
	id: string,
	prompt: string,
	tools: readonly string[] | undefined,
): void {
	if (baselineActiveTools === undefined)
		baselineActiveTools = pi.getActiveTools();
	currentAgentId = id;
	activeAgentPrompt = prompt;
	pi.setActiveTools(tools !== undefined ? [...tools] : baselineActiveTools);
}

function clearActiveAgent(pi: ExtensionAPI): void {
	currentAgentId = null;
	activeAgentPrompt = undefined;
	if (baselineActiveTools !== undefined) pi.setActiveTools(baselineActiveTools);
}

function updateFooter(cfg: Cfg): void {
	if (!cfg.footer.enabled || !footerCtx || footerCtx.hasUI === false) return;
	footerCtx.ui.setStatus(
		cfg.footer.statusKey,
		formatStatus(currentAgentId, cfg.footer),
	);
}

// ── Core agent selection ──

async function selectMainAgent(
	pi: ExtensionAPI,
	ctx: MainCtx,
	id: string | undefined,
	cfg: Cfg,
): Promise<void> {
	const agents = await loadAgentDefs();
	const selected = id ?? (await promptForAgent(ctx, agents));
	if (selected === undefined) return;
	if (selected === null) {
		await selectNone(pi, cfg);
		return;
	}
	const agent = agents.find((a) => a.id === selected);
	if (!agent) {
		warn(ctx, `agent ${selected} was not found`);
		return;
	}
	const applied = await applyAgent(pi, ctx, agent);
	pi.appendEntry(STATE_ENTRY, { agentId: applied ? agent.id : null });
	updateFooter(cfg);
}

async function selectNone(pi: ExtensionAPI, cfg: Cfg): Promise<void> {
	clearActiveAgent(pi);
	pi.appendEntry(STATE_ENTRY, { agentId: null });
	updateFooter(cfg);
}

async function applyAgent(
	pi: ExtensionAPI,
	ctx: MainCtx,
	agent: AgentDef,
): Promise<boolean> {
	const tools = resolveTools(pi, agent);
	if ("issue" in tools) {
		clearActiveAgent(pi);
		warn(ctx, tools.issue);
		return false;
	}
	if (agent.model?.id !== undefined) {
		const model = resolveModel(ctx, agent.model.id);
		if (!model) {
			clearActiveAgent(pi);
			warn(ctx, `model ${agent.model.id} was not found`);
			return false;
		}
		if (!(await pi.setModel(model))) {
			clearActiveAgent(pi);
			warn(ctx, `model ${agent.model.id} could not be applied`);
			return false;
		}
	}
	if (agent.model?.thinking !== undefined)
		pi.setThinkingLevel(agent.model.thinking as any);
	setActiveAgent(pi, agent.id, agent.prompt, tools.tools);
	return true;
}

function resolveTools(
	pi: ExtensionAPI,
	agent: AgentDef,
): { tools?: readonly string[] } | { issue: string } {
	if (agent.tools === undefined) return {};
	const available = pi.getAllTools().map((t) => t.name);
	const result = resolveToolPolicy(agent.tools, available);
	return "issue" in result ? result : { tools: result.tools };
}

function resolveModel(ctx: MainCtx, id: string): Model<Api> | undefined {
	const i = id.indexOf("/");
	return i > 0 && i < id.length - 1
		? ctx.modelRegistry.find(id.slice(0, i), id.slice(i + 1))
		: undefined;
}

async function promptForAgent(
	ctx: MainCtx,
	agents: readonly AgentDef[],
): Promise<string | null | undefined> {
	if (ctx.hasUI === false || ctx.ui.custom === undefined) {
		warn(ctx, "agent selection UI is unavailable");
		return undefined;
	}
	const options: SelectItem[] = [
		{ value: NO_AGENT_VALUE, label: "No agent" },
		...agents.map((a) => ({
			value: a.id,
			label: a.id,
			description: a.description,
		})),
	];
	const selected = await ctx.ui.custom<string | undefined>(
		(tui, theme, _keybindings, done) => {
			const list = new SelectList(options, Math.min(options.length, 10), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			const index = options.findIndex(
				(o) => o.value === (currentAgentId ?? NO_AGENT_VALUE),
			);
			list.setSelectedIndex(Math.max(0, index));
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			return {
				render: (w: number) => list.render(w),
				invalidate: () => list.invalidate(),
				handleInput: (d: string) => {
					list.handleInput(d);
					tui.requestRender();
				},
			};
		},
	);
	if (selected === undefined) return undefined;
	return selected === NO_AGENT_VALUE ? null : selected;
}

// ── Session lifecycle ──

async function restoreAgent(pi: ExtensionAPI, ctx: MainCtx): Promise<void> {
	let agentId: string | null = null;
	for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
		if (
			!isRecord(entry) ||
			entry.type !== "custom" ||
			entry.customType !== STATE_ENTRY
		)
			continue;
		const data = entry.data;
		agentId = isRecord(data) && typeof data.agentId === "string" ? data.agentId : null;
		break;
	}
	if (agentId === null) {
		clearActiveAgent(pi);
		return;
	}
	const agent = (await loadAgentDefs()).find((a) => a.id === agentId);
	if (!agent) {
		warn(ctx, `selected agent ${agentId} was not found`);
		clearActiveAgent(pi);
		return;
	}
	await applyAgent(pi, ctx, agent);
}

function warn(ctx: MainCtx, msg: string): void {
	if (ctx.hasUI !== false) ctx.ui.notify(`[agent-selection] ${msg}`, "warning");
}

// ── Extension entry point ──

export default async function mainAgentSelection(
	pi: ExtensionAPI,
): Promise<void> {
	const cfg = await readConfig();
	if (!cfg.enabled) return;

	pi.on("before_agent_start", async (event) => {
		if (activeAgentPrompt === undefined) return undefined;
		const base = (event as { systemPrompt?: string }).systemPrompt;
		return {
			systemPrompt: [base, activeAgentPrompt].filter(Boolean).join("\n\n"),
		};
	});

	pi.registerCommand(cfg.command, {
		description: "Select the main agent for this working directory",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed.toLowerCase() === "none") {
				await selectNone(pi, cfg);
				return;
			}
			await selectMainAgent(pi, ctx as MainCtx, trimmed || undefined, cfg);
		},
	});

	if (cfg.shortcut !== null) {
		pi.registerShortcut(
			cfg.shortcut as Parameters<typeof pi.registerShortcut>[0],
			{
				description: "Select the main agent",
				handler: async (ctx) => {
					await selectMainAgent(pi, ctx as MainCtx, undefined, cfg);
				},
			},
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		footerCtx = ctx as StatusCtx;
		if (process.env.PI_SUBAGENT_AGENT_ID !== undefined) return;
		await restoreAgent(pi, ctx as MainCtx);
		updateFooter(cfg);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const sx = ctx as StatusCtx;
		if (cfg.footer.enabled && sx !== undefined && sx.hasUI !== false) {
			sx.ui.setStatus(cfg.footer.statusKey, undefined);
		}
		if (footerCtx === sx) footerCtx = undefined;
		currentAgentId = null;
		baselineActiveTools = undefined;
		activeAgentPrompt = undefined;
	});
}
