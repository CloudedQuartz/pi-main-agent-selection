/**
 * Agent Selection Extension — configurable shortcut, coloured footer, session persistence.
 *
 * Config: ~/.pi/agent/extensions/main-agent-selection/config.json
 *
 * Replaces the bundled pi-agent-suite main-agent-selection extension.
 * Disable the bundled extension by setting "enabled": false in
 * ~/.pi/agent/agent-suite/agent-selection/config.json.
 *
 * Default shortcut is Alt+A (Ctrl+Shift+A is indistinguishable from Ctrl+A
 * in the legacy VT input protocol used by most terminals).
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { env } from "node:process";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	type Keybinding,
	type SelectItem,
	SelectList,
	truncateToWidth,
} from "@earendil-works/pi-tui";

// --- Configuration ---

const EXTENSION_DIR = "main-agent-selection";
const CONFIG_FILE_NAME = "config.json";
const STATE_SUBDIR = "state";
const DEFAULT_SHORTCUT = "alt+a";
const DEFAULT_COMMAND = "agent";
const CONTRIBUTION_CHANGE_EVENT = "pi-harness:main-agent-contribution-change";

interface FooterConfig {
	readonly enabled: boolean;
	readonly statusKey: string;
	readonly prefix: string;
	readonly colors: Readonly<Record<string, string>>;
	readonly noneColor: string;
}

interface ExtensionConfig {
	readonly enabled: boolean;
	readonly command: string;
	readonly shortcut: string | null;
	readonly footer: FooterConfig;
}

const DEFAULT_CONFIG: ExtensionConfig = {
	enabled: true,
	command: DEFAULT_COMMAND,
	shortcut: DEFAULT_SHORTCUT,
	footer: { enabled: true, statusKey: "current-agent", prefix: "Agent:", colors: {}, noneColor: "#6B7280" },
};

const RESET = "\x1b[0m";

// --- Agent definition loader ---

const AGENT_FILE_EXTENSION = ".md";
const AGENT_TYPES = ["main", "subagent", "both"] as const;
const TOP_LEVEL_KEYS = ["description", "type", "model", "tools", "agents"] as const;
const MODEL_KEYS = ["id", "thinking"] as const;
const THINKING_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type AgentType = (typeof AGENT_TYPES)[number];
type ThinkingValue = (typeof THINKING_VALUES)[number];

interface AgentDefinition {
	readonly id: string;
	readonly description: string;
	readonly type: AgentType;
	readonly prompt: string;
	readonly model?: { readonly id?: string; readonly thinking?: ThinkingValue };
	readonly tools?: readonly string[];
	readonly agents?: readonly string[];
}

async function loadAgentDefinitions(): Promise<AgentDefinition[]> {
	const agentsDir = await resolveAgentsDir();
	if (agentsDir === undefined) return [];
	const entries = await readdir(agentsDir.path);
	const agentEntries = [...entries].sort().filter((e) => e.endsWith(AGENT_FILE_EXTENSION));
	const agents = await Promise.all(
		agentEntries.map((entry) => readAgentDefinition(agentsDir.path, entry, agentsDir.source)),
	);
	return agents.filter((a): a is AgentDefinition => a !== undefined);
}

async function resolveAgentsDir(): Promise<
	{ readonly path: string; readonly source: "suite" | "legacy" } | undefined
> {
	const suiteAgentsDir = join(getSuiteExtensionDir("agent-selection"), "agents");
	try { await readdir(suiteAgentsDir); return { path: suiteAgentsDir, source: "suite" }; }
	catch (error) { if (!isFileNotFoundError(error)) throw new Error(`failed to read suite agents directory: ${formatError(error)}`); }
	const legacyAgentsDir = join(getAgentDir(), "agents");
	try { await readdir(legacyAgentsDir); return { path: legacyAgentsDir, source: "legacy" }; }
	catch { return undefined; }
}

async function readAgentDefinition(
	agentsDir: string, entry: string, source: "suite" | "legacy",
): Promise<AgentDefinition | undefined> {
	let content: string;
	try { content = await readFile(join(agentsDir, entry), "utf8"); }
	catch (error) {
		if (source === "suite") throw new Error(`failed to read suite agent definition ${entry}: ${formatError(error)}`);
		return undefined;
	}
	return parseAgentDefinition(entry, content);
}

function parseAgentDefinition(fileName: string, content: string): AgentDefinition | undefined {
	const parsed = parseFrontmatter(content);
	const fm = parsed.frontmatter;
	if (!hasOnlyKeys(fm, TOP_LEVEL_KEYS)) return undefined;
	const { type: rawType, description, model: rawModel, tools: rawTools, agents: rawAgents } = fm;
	const type = rawType ?? "main";
	if (!(typeof type === "string" && (AGENT_TYPES as readonly string[]).includes(type))) return undefined;
	if (description !== undefined && typeof description !== "string") return undefined;
	const model = parseModel(rawModel);
	if (model === false) return undefined;
	const tools = parseStringList(rawTools);
	if (tools === false) return undefined;
	const agents = parseStringList(rawAgents);
	if (agents === false) return undefined;
	return {
		id: basename(fileName, AGENT_FILE_EXTENSION), description: description ?? "", type: type as AgentType,
		prompt: parsed.body.trim(), ...(model !== undefined ? { model } : {}), ...(tools !== undefined ? { tools } : {}), ...(agents !== undefined ? { agents } : {}),
	};
}

function parseModel(value: unknown): AgentDefinition["model"] | false | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !hasOnlyKeys(value, MODEL_KEYS)) return false;
	const { id, thinking } = value;
	if (id !== undefined && !(typeof id === "string" && id.indexOf("/") > 0 && id.indexOf("/") < id.length - 1)) return false;
	const isThinking = typeof thinking === "string" && (THINKING_VALUES as readonly string[]).includes(thinking);
	if (thinking !== undefined && !isThinking) return false;
	return { ...(typeof id === "string" ? { id } : {}), ...(thinking !== undefined && isThinking ? { thinking: thinking as ThinkingValue } : {}) };
}

function parseStringList(value: unknown): readonly string[] | undefined | false {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return false;
	const values: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string" || item.trim().length === 0 || seen.has(item)) return false;
		seen.add(item); values.push(item);
	}
	return values;
}

// --- Tool policy ---

function resolveToolPolicy(
	patterns: readonly string[], availableTools: readonly string[],
): { readonly tools: readonly string[] } | { readonly issue: string } {
	const resolved: string[] = [], seen = new Set<string>();
	for (const pattern of patterns) {
		if (isFullWildcard(pattern)) return { issue: "full wildcard * is not allowed" };
		const matches = resolvePatternMatches(pattern, availableTools);
		if (matches.length === 0) return { issue: `tool pattern ${pattern} did not match any available tool` };
		for (const tool of matches) { if (!seen.has(tool)) { seen.add(tool); resolved.push(tool); } }
	}
	return { tools: resolved };
}

function resolvePatternMatches(pattern: string, availableTools: readonly string[]): string[] {
	if (pattern.includes("*")) {
		const expression = new RegExp(`^${pattern.split("*").map(escapeRegexSegment).join(".*")}$`);
		return availableTools.filter((tool) => expression.test(tool));
	}
	return availableTools.includes(pattern) ? [pattern] : [];
}

function escapeRegexSegment(segment: string): string { return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function isFullWildcard(pattern: string): boolean { return pattern.includes("*") && pattern.replaceAll("*", "").length === 0; }

// --- State persistence ---

const STATE_HASH_ENCODING = "hex";

async function writeSelectedAgentState(state: { readonly cwd: string; readonly activeAgentId: string | null }): Promise<void> {
	const stateDir = join(getSuiteExtensionDir("agent-selection"), STATE_SUBDIR);
	await mkdir(stateDir, { recursive: true });
	await writeFile(join(stateDir, `${selectedAgentStateFileName(state.cwd)}.json`), JSON.stringify(state, null, 2));
}

async function loadSelectedAgentState(cwd: string): Promise<
	| { readonly kind: "missing" }
	| { readonly kind: "valid"; readonly state: { readonly cwd: string; readonly activeAgentId: string | null } }
	| { readonly kind: "invalid"; readonly issue: string }
> {
	const hash = selectedAgentStateFileName(cwd);
	const paths = [
		join(getSuiteExtensionDir("agent-selection"), STATE_SUBDIR, `${hash}.json`),
		join(getAgentDir(), "agent-selection", "state", `${hash}.json`),
	];
	let content: string | undefined;
	for (const filePath of paths) {
		try { content = await readFile(filePath, "utf8"); break; }
		catch (error) { if (!isFileNotFoundError(error)) return { kind: "invalid", issue: `failed to read selected-agent state: ${formatError(error)}` }; }
	}
	if (content === undefined) return { kind: "missing" };
	let parsed: unknown;
	try { parsed = JSON.parse(content); }
	catch (error) { return { kind: "invalid", issue: `failed to parse selected-agent state: ${formatError(error)}` }; }
	const STATE_KEYS = ["cwd", "activeAgentId"] as const;
	if (!isRecord(parsed) || !hasOnlyKeys(parsed, STATE_KEYS))
		return { kind: "invalid", issue: "selected-agent state must contain only cwd and activeAgentId" };
	const cwdVal = parsed[STATE_KEYS[0]], activeAgentId = parsed[STATE_KEYS[1]];
	if (typeof cwdVal !== "string") return { kind: "invalid", issue: "selected-agent state cwd must be a string" };
	if (!(typeof activeAgentId === "string" || activeAgentId === null))
		return { kind: "invalid", issue: "selected-agent state activeAgentId must be a string or null" };
	if (cwdVal !== cwd) return { kind: "invalid", issue: "selected-agent state cwd does not match current working directory" };
	return { kind: "valid", state: { cwd: cwdVal, activeAgentId } };
}

function selectedAgentStateFileName(cwd: string): string {
	return createHash("sha256").update(cwd).digest(STATE_HASH_ENCODING);
}

// --- Suite storage helpers ---

const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";

function getAgentSuiteDir(): string {
	const configuredDir = env[AGENT_SUITE_DIR_ENV];
	if (configuredDir !== undefined && configuredDir.length > 0) return expandHomeDirectory(configuredDir);
	return join(getAgentDir(), "agent-suite");
}

function getSuiteExtensionDir(extensionDir: string): string { return join(getAgentSuiteDir(), extensionDir); }

function expandHomeDirectory(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

// --- Config ---

async function readConfig(): Promise<ExtensionConfig> {
	let content: string;
	try { content = await readFile(join(getAgentDir(), "extensions", EXTENSION_DIR, CONFIG_FILE_NAME), "utf8"); }
	catch { return DEFAULT_CONFIG; }
	let parsed: unknown;
	try { parsed = JSON.parse(content); } catch { return DEFAULT_CONFIG; }
	if (!isRecord(parsed)) return DEFAULT_CONFIG;
	const enabled = typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_CONFIG.enabled;
	const command = typeof parsed.command === "string" && parsed.command.trim().length > 0 ? parsed.command.trim() : DEFAULT_CONFIG.command;
	const shortcut = parsed.shortcut === null ? null
		: typeof parsed.shortcut === "string" && parsed.shortcut.trim().length > 0 ? parsed.shortcut.trim() : DEFAULT_CONFIG.shortcut;
	let footer: FooterConfig = DEFAULT_CONFIG.footer;
	if (isRecord(parsed.footer)) {
		const f = parsed.footer;
		const sanitize = (s: string) => s.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
		footer = {
			enabled: typeof f.enabled === "boolean" ? f.enabled : DEFAULT_CONFIG.footer.enabled,
			statusKey: typeof f.statusKey === "string" && f.statusKey.trim().length > 0 ? f.statusKey.trim() : DEFAULT_CONFIG.footer.statusKey,
			prefix: typeof f.prefix === "string" ? sanitize(f.prefix) : DEFAULT_CONFIG.footer.prefix,
			colors: isRecord(f.colors) ? Object.fromEntries(
				Object.entries(f.colors).filter((e): e is [string, string] => typeof e[1] === "string" && /^#[\da-f]{6}$/i.test(e[1])),
			) : { ...DEFAULT_CONFIG.footer.colors },
			noneColor: typeof f.noneColor === "string" && /^#[\da-f]{6}$/i.test(f.noneColor) ? f.noneColor : DEFAULT_CONFIG.footer.noneColor,
		};
	}
	return { enabled, command, shortcut, footer };
}

// --- Footer/status ---

function formatAgentStatus(agentId: string | null, config: FooterConfig): string {
	const safeAgentId = (agentId ?? "none").replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
	const color = agentColor(agentId, config);
	return `${fg(color, config.prefix)}${fg(color, safeAgentId)}`;
}

function agentColor(agentId: string | null, config: FooterConfig): string {
	if (agentId === null) return config.noneColor;
	const exactMatch = config.colors[agentId];
	if (exactMatch !== undefined) return exactMatch;
	const lower = agentId.toLowerCase();
	for (const [id, color] of Object.entries(config.colors)) { if (id.toLowerCase() === lower) return color; }
	return hashColor(agentId);
}

function hashColor(text: string): string {
	const digest = createHash("sha256").update(text).digest();
	return hslToHex(Math.round((digest[0] / 255) * 360), 66 + (digest[1] % 10), 62 + (digest[2] % 10));
}

function fg(hex: string, text: string): string {
	const [r, g, b] = hexToRgb(hex);
	return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function hexToRgb(hex: string): [number, number, number] {
	const n = hex.replace("#", "");
	return [Number.parseInt(n.slice(0, 2), 16), Number.parseInt(n.slice(2, 4), 16), Number.parseInt(n.slice(4, 6), 16)];
}

function hslToHex(hue: number, sat: number, lit: number): string {
	const s = sat / 100, l = lit / 100, c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = l - c / 2;
	const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
	return `#${[r, g, b].map((ch) => Math.round((ch + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

// --- Session replacement handoff ---

const SESSION_HANDOFF_PROPERTY = "__piHarnessMainAgentSelectionSessionReplacementHandoffs";
type SessionHandoff = { readonly found: false } | { readonly found: true; readonly activeAgentId: string | null };

function isHandoffReason(reason: string | undefined): boolean { return reason === "new" || reason === "fork" || reason === "resume"; }

function captureHandoff(pi: ExtensionAPI, event: unknown, ctx: MainAgentContext): void {
	const e = event as { reason?: string; targetSessionFile?: string };
	if (!isHandoffReason(e.reason)) return;
	const key = e.targetSessionFile ?? ctx.sessionManager.getSessionFile() ?? resolve(ctx.cwd);
	getHandoffStore().set(key, activeAgentId(pi) ?? null);
}

async function restoreHandoff(pi: ExtensionAPI, event: unknown, ctx: MainAgentContext): Promise<boolean> {
	if (!isHandoffReason((event as { reason?: string }).reason)) return false;
	const key = ctx.sessionManager.getSessionFile() ?? resolve(ctx.cwd);
	const handoff = consumeHandoff(key);
	if (!handoff.found) return false;
	if (handoff.activeAgentId === null) { clearActiveAgent(pi); return true; }
	const agents = await loadSelectableAgents();
	const agent = agents.find((a) => a.id === handoff.activeAgentId);
	if (agent === undefined) { reportIssue(ctx, `selected agent ${handoff.activeAgentId} was not found`); clearActiveAgent(pi); return true; }
	await applyAgentSelection(pi, ctx, agent);
	return true;
}

function getHandoffStore(): Map<string, string | null> {
	const carrier = globalThis as { [SESSION_HANDOFF_PROPERTY]?: Map<string, string | null> };
	if (carrier[SESSION_HANDOFF_PROPERTY] !== undefined) return carrier[SESSION_HANDOFF_PROPERTY]!;
	const store = new Map<string, string | null>();
	carrier[SESSION_HANDOFF_PROPERTY] = store;
	return store;
}

function consumeHandoff(key: string): SessionHandoff {
	const store = getHandoffStore();
	if (!store.has(key)) return { found: false };
	const activeAgentId = store.get(key) ?? null;
	store.delete(key);
	return { found: true, activeAgentId };
}

// --- Active agent state (module-level) ---

let activeAgentPrompt: string | undefined;
let baselineActiveTools: string[] | undefined;

function setActiveAgent(pi: ExtensionAPI, prompt: string, tools: readonly string[] | undefined): void {
	if (baselineActiveTools === undefined) baselineActiveTools = pi.getActiveTools();
	activeAgentPrompt = prompt;
	pi.setActiveTools(tools !== undefined ? [...tools] : baselineActiveTools!);
	(pi.events as unknown as { emit(name: string, data: undefined): void }).emit(CONTRIBUTION_CHANGE_EVENT, undefined);
}

function clearActiveAgent(pi: ExtensionAPI): void {
	activeAgentPrompt = undefined;
	if (baselineActiveTools !== undefined) pi.setActiveTools(baselineActiveTools);
	(pi.events as unknown as { emit(name: string, data: undefined): void }).emit(CONTRIBUTION_CHANGE_EVENT, undefined);
}

function activeAgentId(pi: ExtensionAPI): string | undefined {
	// Read from the runtime composition if another extension owns it, otherwise fall back to module state
	const holder = (pi.events as unknown as Record<string, unknown>)[RUNTIME_PROPERTY];
	if (holder !== undefined && !(holder as { stale?: boolean }).stale) {
		return ((holder as { runtime: unknown }).runtime as { getMainAgentContribution?: () => { agent?: { id?: string } } | undefined })?.getMainAgentContribution?.()?.agent?.id;
	}
	return undefined;
}

const RUNTIME_PROPERTY = "__piHarnessAgentRuntimeCompositionV5";

// --- Context types ---

interface MainAgentContext {
	readonly cwd: string;
	readonly hasUI?: boolean;
	readonly sessionManager: { getSessionFile(): string | undefined };
	readonly ui: {
		custom?<T>(factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: MainAgentSelectorKeybindings, done: (result: T) => void) => Component | Promise<Component>): Promise<T>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
	readonly modelRegistry: { find(provider: string, modelId: string): Model<Api> | undefined };
}

type MainAgentSelectorKeybinding = Extract<Keybinding, "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel">;
interface MainAgentSelectorKeybindings { matches(data: string, keybinding: MainAgentSelectorKeybinding): boolean; }

// --- Searchable agent selector UI ---

const NO_AGENT_LABEL = "No agent";
const NO_AGENT_ARGUMENT = "none";
const NO_AGENT_VALUE = "__none__";

class SearchableAgentSelector implements Component, Focusable {
	private readonly options: readonly SelectItem[];
	private readonly keybindings: MainAgentSelectorKeybindings;
	private readonly searchInput = new Input();
	private readonly theme: { fg(color: string, text: string): string };
	private readonly onSelect: (value: string) => void;
	private readonly onCancel: () => void;
	private selectList: SelectList;
	private filteredOptions: readonly SelectItem[];
	private selectedValue: string;
	private readonly maxVisibleOptions: number;
	private _focused = false;

	constructor(options: {
		readonly allOptions: readonly SelectItem[];
		readonly currentAgentId: string | null;
		readonly keybindings: MainAgentSelectorKeybindings;
		readonly theme: { fg(color: string, text: string): string };
		readonly onSelect: (value: string) => void;
		readonly onCancel: () => void;
	}) {
		this.options = options.allOptions;
		this.keybindings = options.keybindings;
		this.theme = options.theme;
		this.onSelect = options.onSelect;
		this.onCancel = options.onCancel;
		this.filteredOptions = options.allOptions;
		this.selectedValue = options.currentAgentId ?? NO_AGENT_VALUE;
		this.maxVisibleOptions = Math.min(options.allOptions.length, 10);
		this.selectList = this.makeList(this.filteredOptions);
		this.syncSelectedIndex();
	}

	get focused(): boolean { return this._focused; }
	set focused(v: boolean) { this._focused = v; this.searchInput.focused = v; }

	render(width: number): string[] {
		const lines = [truncateToWidth(this.theme.fg("dim", "Type to search agents • navigate • select • cancel"), width), ...this.searchInput.render(width)];
		if (this.filteredOptions.length === 0) lines.push(truncateToWidth(this.theme.fg("warning", "  No matching agents"), width));
		else lines.push(...this.selectList.render(width));
		return lines;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) { this.moveSelection(-1); return; }
		if (this.keybindings.matches(data, "tui.select.down")) { this.moveSelection(1); return; }
		if (this.keybindings.matches(data, "tui.select.confirm")) { if (this.filteredOptions.length > 0) this.onSelect(this.selectedValue); return; }
		if (this.keybindings.matches(data, "tui.select.cancel")) { this.onCancel(); return; }
		const prev = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		if (this.searchInput.getValue() !== prev) this.applySearch();
	}

	invalidate(): void { this.searchInput.invalidate(); this.selectList.invalidate(); }

	private applySearch(): void {
		const q = this.searchInput.getValue().toLowerCase();
		this.filteredOptions = q.length === 0 ? this.options : this.options.filter((o) => o.label.toLowerCase().includes(q));
		this.selectList = this.makeList(this.filteredOptions);
		this.syncSelectedIndex();
	}

	private syncSelectedIndex(): void {
		const idx = this.filteredOptions.findIndex((o) => o.value === this.selectedValue);
		if (idx >= 0) { this.selectList.setSelectedIndex(idx); return; }
		const first = this.filteredOptions[0];
		if (first !== undefined) { this.selectedValue = first.value; this.selectList.setSelectedIndex(0); }
	}

	private moveSelection(dir: -1 | 1): void {
		if (this.filteredOptions.length === 0) return;
		const cur = this.filteredOptions.findIndex((o) => o.value === this.selectedValue);
		const next = ((cur >= 0 ? cur : 0) + dir + this.filteredOptions.length) % this.filteredOptions.length;
		const opt = this.filteredOptions[next];
		if (opt !== undefined) { this.selectedValue = opt.value; this.selectList.setSelectedIndex(next); }
	}

	private makeList(options: readonly SelectItem[]): SelectList {
		return new SelectList([...options], this.maxVisibleOptions, {
			selectedPrefix: (t: string) => this.theme.fg("accent", t),
			selectedText: (t: string) => this.theme.fg("accent", t),
			description: (t: string) => this.theme.fg("muted", t),
			scrollInfo: (t: string) => this.theme.fg("dim", t),
			noMatch: (t: string) => this.theme.fg("warning", t),
		});
	}
}

// --- Core agent selection ---

async function loadSelectableAgents(): Promise<AgentDefinition[]> {
	const agents = await loadAgentDefinitions();
	return agents.filter((a) => a.type === "main" || a.type === "both");
}

async function selectMainAgent(pi: ExtensionAPI, ctx: MainAgentContext, explicitAgentId: string | undefined, config: ExtensionConfig): Promise<void> {
	const agents = await loadSelectableAgents();
	const selectedAgentId = explicitAgentId ?? (await promptForAgent(pi, ctx, agents));
	if (selectedAgentId === undefined) return;
	if (selectedAgentId === null) { await selectNoMainAgent(pi, ctx, config); return; }
	const agent = agents.find((a) => a.id === selectedAgentId);
	if (agent === undefined) { reportIssue(ctx, `agent ${selectedAgentId} was not found`); return; }
	const applied = await applyAgentSelection(pi, ctx, agent);
	await writeSelectedAgentState({ cwd: resolve(ctx.cwd), activeAgentId: applied ? agent.id : null });
	refreshFooterStatus(ctx, pi, config);
}

async function selectNoMainAgent(pi: ExtensionAPI, ctx: MainAgentContext, config: ExtensionConfig): Promise<void> {
	clearActiveAgent(pi);
	await writeSelectedAgentState({ cwd: resolve(ctx.cwd), activeAgentId: null });
	refreshFooterStatus(ctx, pi, config);
}

async function applyAgentSelection(pi: ExtensionAPI, ctx: MainAgentContext, agent: AgentDefinition): Promise<boolean> {
	const resolvedTools = resolveMainAgentTools(pi, agent);
	if ("issue" in resolvedTools) { clearActiveAgent(pi); reportIssue(ctx, resolvedTools.issue); return false; }
	if (agent.model?.id !== undefined) {
		const model = resolveModel(ctx, agent.model.id);
		if (model === undefined) { clearActiveAgent(pi); reportIssue(ctx, `model ${agent.model.id} was not found`); return false; }
		const modelApplied = await pi.setModel(model);
		if (!modelApplied) { clearActiveAgent(pi); reportIssue(ctx, `model ${agent.model.id} could not be applied`); return false; }
	}
	if (agent.model?.thinking !== undefined) pi.setThinkingLevel(agent.model.thinking);
	setActiveAgent(pi, agent.prompt, resolvedTools.tools);
	return true;
}

function resolveMainAgentTools(pi: ExtensionAPI, agent: AgentDefinition): { readonly tools?: readonly string[] } | { readonly issue: string } {
	if (agent.tools === undefined) return {};
	const availableToolNames = pi.getAllTools().map((t) => t.name);
	const resolved = resolveToolPolicy(agent.tools, availableToolNames);
	if ("issue" in resolved) return resolved;
	return { tools: resolved.tools };
}

function resolveModel(ctx: MainAgentContext, modelId: string): Model<Api> | undefined {
	const i = modelId.indexOf("/");
	if (i <= 0 || i === modelId.length - 1) return undefined;
	return ctx.modelRegistry.find(modelId.slice(0, i), modelId.slice(i + 1));
}

async function promptForAgent(pi: ExtensionAPI, ctx: MainAgentContext, agents: readonly AgentDefinition[]): Promise<string | null | undefined> {
	if (ctx.hasUI === false || ctx.ui.custom === undefined) { reportIssue(ctx, "agent selection UI is unavailable"); return undefined; }
	const composition = getExistingComposition(pi);
	const currentAgentId = composition?.getMainAgentContribution?.()?.agent?.id ?? null;
	const options: SelectItem[] = [
		{ value: NO_AGENT_VALUE, label: NO_AGENT_LABEL },
		...agents.map((a) => ({ value: a.id, label: `${a.id} — ${a.description}` })),
	];
	const selected = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const selector = new SearchableAgentSelector({ allOptions: options, currentAgentId, keybindings, theme, onSelect: (v) => done(v), onCancel: () => done(undefined) });
		return {
			get focused() { return selector.focused; },
			set focused(v: boolean) { selector.focused = v; },
			render(w: number) { return selector.render(w); },
			invalidate() { selector.invalidate(); },
			handleInput(d: string) { selector.handleInput(d); tui.requestRender(); },
		};
	});
	if (selected === undefined) return undefined;
	return selected === NO_AGENT_VALUE ? null : selected;
}

function getExistingComposition(pi: ExtensionAPI): { getMainAgentContribution?: () => { agent?: { id?: string } } | undefined } | undefined {
	const holder = (pi.events as unknown as Record<string, unknown>)[RUNTIME_PROPERTY];
	if (holder !== undefined && !(holder as { stale?: boolean }).stale) return (holder as { runtime: unknown }).runtime as { getMainAgentContribution?: () => { agent?: { id?: string } } | undefined };
	return undefined;
}

// --- Session lifecycle ---

async function restoreSelectedMainAgent(pi: ExtensionAPI, ctx: MainAgentContext): Promise<void> {
	const normalizedCwd = resolve(ctx.cwd);
	const state = await loadSelectedAgentState(normalizedCwd);
	if (state.kind === "missing" || state.kind === "invalid" || state.state.activeAgentId === null) {
		if (state.kind === "invalid") reportIssue(ctx, state.issue);
		clearActiveAgent(pi);
		return;
	}
	const agents = await loadSelectableAgents();
	const agent = agents.find((a) => a.id === state.state.activeAgentId);
	if (agent === undefined) {
		reportIssue(ctx, `selected agent ${state.state.activeAgentId} was not found`);
		clearActiveAgent(pi);
		return;
	}
	await applyAgentSelection(pi, ctx, agent);
}

function refreshFooterStatus(ctx: unknown, pi: ExtensionAPI, config: ExtensionConfig): void {
	if (!config.footer.enabled) return;
	const statusCtx = ctx as { hasUI?: boolean; ui: { setStatus(key: string, text: string | undefined): void } } | undefined;
	if (statusCtx === undefined || statusCtx.hasUI === false) return;
	const composition = getExistingComposition(pi);
	const agentId = composition?.getMainAgentContribution?.()?.agent?.id ?? null;
	statusCtx.ui.setStatus(config.footer.statusKey, formatAgentStatus(agentId, config.footer));
}

// --- Extension entry point ---

export default async function mainAgentSelection(pi: ExtensionAPI): Promise<void> {
	const config = await readConfig();
	if (!config.enabled) return;

	let activeCtx: { hasUI?: boolean; ui: { setStatus(key: string, text: string | undefined): void } } | undefined;

	// System prompt injection for the selected agent
	pi.on("before_agent_start", async (event) => {
		if (activeAgentPrompt === undefined) return undefined;
		const basePrompt = (event as { systemPrompt?: string }).systemPrompt;
		return { systemPrompt: [basePrompt, activeAgentPrompt].filter(Boolean).join("\n\n") };
	});

	pi.registerCommand(config.command, {
		description: "Select the main agent for this working directory",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed.toLowerCase() === NO_AGENT_ARGUMENT) { await selectNoMainAgent(pi, ctx as MainAgentContext, config); return; }
			await selectMainAgent(pi, ctx as MainAgentContext, trimmed || undefined, config);
		},
	});

	if (config.shortcut !== null) {
		pi.registerShortcut(config.shortcut as Parameters<typeof pi.registerShortcut>[0], {
			description: "Select the main agent",
			handler: async (ctx) => { await selectMainAgent(pi, ctx as MainAgentContext, undefined, config); },
		});
	}

	pi.on("session_start", async (event, ctx) => {
		activeCtx = ctx as typeof activeCtx;
		if (process.env.PI_SUBAGENT_AGENT_ID !== undefined) return;
		const mainCtx = ctx as MainAgentContext;
		if (await restoreHandoff(pi, event, mainCtx)) { refreshFooterStatus(ctx, pi, config); return; }
		const reason = (event as { reason?: string }).reason;
		if (reason !== "startup" && reason !== "reload" && reason !== "resume") { refreshFooterStatus(ctx, pi, config); return; }
		await restoreSelectedMainAgent(pi, mainCtx);
		refreshFooterStatus(ctx, pi, config);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const statusCtx = ctx as typeof activeCtx;
		if (config.footer.enabled && statusCtx !== undefined && statusCtx.hasUI !== false) {
			statusCtx.ui.setStatus(config.footer.statusKey, undefined);
		}
		if (activeCtx === statusCtx) activeCtx = undefined;
		if (process.env.PI_SUBAGENT_AGENT_ID !== undefined) return;
		captureHandoff(pi, _event, ctx as MainAgentContext);
		baselineActiveTools = undefined;
		activeAgentPrompt = undefined;
	});

	(pi.events as unknown as { on?: (name: string, fn: () => void) => unknown }).on?.(CONTRIBUTION_CHANGE_EVENT, () => {
		if (config.footer.enabled && activeCtx !== undefined && activeCtx.hasUI !== false) {
			const composition = getExistingComposition(pi);
			const agentId = composition?.getMainAgentContribution?.()?.agent?.id ?? null;
			activeCtx.ui.setStatus(config.footer.statusKey, formatAgentStatus(agentId, config.footer));
		}
	});
}

// --- Utility ---

function reportIssue(ctx: MainAgentContext, issue: string): void {
	if (ctx.hasUI === false) return;
	ctx.ui.notify(`[agent-selection] ${issue}`, "warning");
}

function formatError(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isFileNotFoundError(error: unknown): boolean {
	if (!isRecord(error)) return false;
	return (error as { code?: unknown }).code === "ENOENT";
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}