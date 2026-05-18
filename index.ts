/**
 * Agent Selection Extension — configurable shortcut, coloured footer, session persistence.
 *
 * Config: ~/.pi/agent/extensions/main-agent-selection/config.json
 *
 * Replaces the bundled pi-agent-suite main-agent-selection extension.
 * Disable the bundled extension by setting "enabled": false in
 * ~/.pi/agent/agent-suite/agent-selection/config.json.
 *
 * Default shortcut is Alt+A (works on Windows Terminal, unlike Ctrl+Shift+A
 * which cannot be distinguished from Ctrl+A in legacy VT input).
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const EXTENSION_DIR = "main-agent-selection";
const CONFIG_FILE_NAME = "config.json";
const STATE_SUBDIR = "state";

const DEFAULT_SHORTCUT = "alt+a";
const DEFAULT_COMMAND = "agent";
const STATUS_KEY = "current-agent";

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
	footer: {
		enabled: true,
		statusKey: STATUS_KEY,
		prefix: "Agent:",
		colors: {},
		noneColor: "#6B7280",
	},
};

const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// Agent definition types & loader (inlined from agent-registry)
// ---------------------------------------------------------------------------

const AGENT_FILE_EXTENSION = ".md";
const AGENT_TYPES = ["main", "subagent", "both"] as const;
const TOP_LEVEL_KEYS = [
	"description",
	"type",
	"model",
	"tools",
	"agents",
] as const;
const MODEL_KEYS = ["id", "thinking"] as const;
const THINKING_VALUES = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

type AgentType = (typeof AGENT_TYPES)[number];
type ThinkingValue = (typeof THINKING_VALUES)[number];

interface AgentDefinition {
	readonly id: string;
	readonly description: string;
	readonly type: AgentType;
	readonly prompt: string;
	readonly model?: {
		readonly id?: string;
		readonly thinking?: ThinkingValue;
	};
	readonly tools?: readonly string[];
	readonly agents?: readonly string[];
}

async function loadAgentDefinitions(): Promise<AgentDefinition[]> {
	const agentsDir = await resolveAgentsDir();
	if (agentsDir === undefined) {
		return [];
	}

	const entries = await readdir(agentsDir.path);
	const agentEntries = [...entries]
		.sort()
		.filter((entry) => entry.endsWith(AGENT_FILE_EXTENSION));
	const agents = await Promise.all(
		agentEntries.map((entry) =>
			readAgentDefinition(agentsDir.path, entry, agentsDir.source),
		),
	);
	return agents.filter(
		(agent): agent is AgentDefinition => agent !== undefined,
	);
}

async function resolveAgentsDir(): Promise<
	{ readonly path: string; readonly entries: readonly string[]; readonly source: "suite" | "legacy" } | undefined
> {
	const suiteAgentsDir = join(
		getSuiteExtensionDir("agent-selection"),
		"agents",
	);
	try {
		return {
			path: suiteAgentsDir,
			entries: await readdir(suiteAgentsDir),
			source: "suite" as const,
		};
	} catch (error) {
		if (!isFileNotFoundError(error)) {
			throw new Error(
				`failed to read suite agents directory: ${formatError(error)}`,
			);
		}
	}

	const legacyAgentsDir = join(getAgentDir(), "agents");
	try {
		return {
			path: legacyAgentsDir,
			entries: await readdir(legacyAgentsDir),
			source: "legacy" as const,
		};
	} catch {
		return undefined;
	}
}

async function readAgentDefinition(
	agentsDir: string,
	entry: string,
	source: "suite" | "legacy",
): Promise<AgentDefinition | undefined> {
	let content: string;
	try {
		content = await readFile(join(agentsDir, entry), "utf8");
	} catch (error) {
		if (source === "suite") {
			throw new Error(
				`failed to read suite agent definition ${entry}: ${formatError(error)}`,
			);
		}
		return undefined;
	}

	return parseAgentDefinition(entry, content);
}

function parseAgentDefinition(
	fileName: string,
	content: string,
): AgentDefinition | undefined {
	const parsed = parseFrontmatter(content);
	const frontmatter = parsed.frontmatter;
	if (!hasOnlyKeys(frontmatter, TOP_LEVEL_KEYS)) {
		return undefined;
	}

	const {
		type: rawType,
		description,
		model: rawModel,
		tools: rawTools,
		agents: rawAgents,
	} = frontmatter;
	const type = rawType ?? "main";
	if (!isAgentType(type)) {
		return undefined;
	}

	if (description !== undefined && typeof description !== "string") {
		return undefined;
	}

	const model = parseModel(rawModel);
	if (model === false) {
		return undefined;
	}

	const tools = parseStringList(rawTools);
	if (tools === false) {
		return undefined;
	}

	const agents = parseStringList(rawAgents);
	if (agents === false) {
		return undefined;
	}

	return {
		id: basename(fileName, AGENT_FILE_EXTENSION),
		description: description ?? "",
		type,
		prompt: parsed.body.trim(),
		...(model !== undefined ? { model } : {}),
		...(tools !== undefined ? { tools } : {}),
		...(agents !== undefined ? { agents } : {}),
	};
}

function parseModel(value: unknown): AgentDefinition["model"] | false {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value) || !hasOnlyKeys(value, MODEL_KEYS)) {
		return false;
	}

	const { id, thinking } = value;
	if (id !== undefined && !isModelId(id)) {
		return false;
	}

	if (thinking !== undefined && !isThinkingValue(thinking)) {
		return false;
	}

	return {
		...(typeof id === "string" ? { id } : {}),
		...(isThinkingValue(thinking) ? { thinking } : {}),
	};
}

function isModelId(value: unknown): value is string {
	if (typeof value !== "string") {
		return false;
	}
	const separatorIndex = value.indexOf("/");
	return separatorIndex > 0 && separatorIndex < value.length - 1;
}

function parseStringList(
	value: unknown,
): readonly string[] | undefined | false {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return false;
	}

	const values: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (
			typeof item !== "string" ||
			item.trim().length === 0 ||
			seen.has(item)
		) {
			return false;
		}
		seen.add(item);
		values.push(item);
	}

	return values;
}

function isAgentType(value: unknown): value is AgentType {
	return (
		typeof value === "string" &&
		(AGENT_TYPES as readonly string[]).includes(value)
	);
}

function isThinkingValue(value: unknown): value is ThinkingValue {
	return (
		typeof value === "string" &&
		(THINKING_VALUES as readonly string[]).includes(value)
	);
}

// ---------------------------------------------------------------------------
// Agent runtime composition (inlined from agent-runtime-composition)
// Uses the same global property name for compatibility with other suite extensions.
// ---------------------------------------------------------------------------

const RUNTIME_PROPERTY = "__piHarnessAgentRuntimeCompositionV5";
const MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT =
	"pi-harness:main-agent-contribution-change";

interface MainAgentRuntimeInfo {
	readonly id: string;
	readonly tools?: readonly string[];
	readonly agents?: readonly string[];
}

export interface MainAgentContribution {
	readonly prompt: string;
	readonly tools?: readonly string[];
	readonly agent?: MainAgentRuntimeInfo;
}

interface PromptContribution {
	readonly prompt?: string;
	readonly buildPrompt?:
		| (() => Promise<string | undefined> | string | undefined)
		| undefined;
	readonly requiredToolName?: string;
}

type ActiveToolFilter = (
	toolNames: readonly string[],
	ctx: unknown,
) => Promise<readonly string[]> | readonly string[];

interface AgentRuntimeComposition {
	setMainAgentContribution(
		contribution: MainAgentContribution | undefined,
	): void;
	clearMainAgentContribution(): void;
	getMainAgentContribution(): MainAgentContribution | undefined;
	setRunSubagentContribution(
		contribution: PromptContribution | undefined,
	): void;
	setRunSubagentActiveToolFilter(filter: ActiveToolFilter | undefined): void;
	setConsultAdvisorContribution(
		contribution: PromptContribution | undefined,
	): void;
	setConveneCouncilContribution(
		contribution: PromptContribution | undefined,
	): void;
}

interface RuntimeCompositionHolder {
	runtime: AgentRuntimeComposition;
	stale: boolean;
}

interface RuntimeCompositionCarrier {
	[RUNTIME_PROPERTY]?: RuntimeCompositionHolder;
}

interface AgentRuntimeEventBus {
	emit(
		eventName: typeof MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
		data: undefined,
	): void;
}

function getAgentRuntimeComposition(pi: ExtensionAPI): AgentRuntimeComposition {
	const carrier = pi.events as RuntimeCompositionCarrier;
	const existing = carrier[RUNTIME_PROPERTY];
	if (existing !== undefined && !existing.stale) {
		return existing.runtime;
	}

	const holder: RuntimeCompositionHolder = {
		runtime: new AgentRuntimeCompositionImpl(pi),
		stale: false,
	};
	if (existing !== undefined) {
		carrier[RUNTIME_PROPERTY] = holder;
		return holder.runtime;
	}

	Object.defineProperty(carrier, RUNTIME_PROPERTY, {
		configurable: false,
		enumerable: false,
		value: holder,
		writable: true,
	});
	return holder.runtime;
}

function markAgentRuntimeCompositionStale(pi: ExtensionAPI): void {
	const holder = (pi.events as RuntimeCompositionCarrier)[RUNTIME_PROPERTY];
	if (holder === undefined) {
		return;
	}
	holder.stale = true;
}

class AgentRuntimeCompositionImpl implements AgentRuntimeComposition {
	private mainAgentContribution: MainAgentContribution | undefined;
	private runSubagentContribution: PromptContribution | undefined;
	private runSubagentActiveToolFilter: ActiveToolFilter | undefined;
	private consultAdvisorContribution: PromptContribution | undefined;
	private conveneCouncilContribution: PromptContribution | undefined;
	private baselineActiveTools: string[] | undefined;

	public constructor(private readonly pi: ExtensionAPI) {
		this.pi.on("before_agent_start", async (event, ctx) => {
			const activeToolNames = await this.resolveActiveToolNames(ctx);
			const mainAgentPrompt = this.mainAgentContribution?.prompt;
			const runSubagentPrompt = await resolvePromptContribution(
				this.runSubagentContribution,
				activeToolNames,
			);
			const consultAdvisorPrompt = await resolvePromptContribution(
				this.consultAdvisorContribution,
				activeToolNames,
			);
			const conveneCouncilPrompt = await resolvePromptContribution(
				this.conveneCouncilContribution,
				activeToolNames,
			);
			const contributionPrompts = [
				mainAgentPrompt,
				runSubagentPrompt,
				consultAdvisorPrompt,
				conveneCouncilPrompt,
			].filter((prompt) => prompt !== undefined && prompt.length > 0);
			if (contributionPrompts.length === 0) {
				return undefined;
			}

			const basePrompt = (event as { systemPrompt?: string }).systemPrompt;
			const systemPrompt = [basePrompt, ...contributionPrompts]
				.filter(Boolean)
				.join("\n\n");
			return { systemPrompt };
		});
	}

	public setMainAgentContribution(
		contribution: MainAgentContribution | undefined,
	): void {
		if (this.baselineActiveTools === undefined) {
			this.baselineActiveTools = this.pi.getActiveTools();
		}

		this.mainAgentContribution = contribution;
		this.pi.setActiveTools(
			contribution?.tools !== undefined
				? [...contribution.tools]
				: this.baselineActiveTools,
		);
		(this.pi.events as unknown as AgentRuntimeEventBus).emit(
			MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
			undefined,
		);
	}

	public clearMainAgentContribution(): void {
		if (this.mainAgentContribution === undefined) {
			return;
		}
		this.setMainAgentContribution(undefined);
	}

	public getMainAgentContribution(): MainAgentContribution | undefined {
		return this.mainAgentContribution;
	}

	public setRunSubagentContribution(
		contribution: PromptContribution | undefined,
	): void {
		this.runSubagentContribution = contribution;
	}

	public setRunSubagentActiveToolFilter(
		filter: ActiveToolFilter | undefined,
	): void {
		this.runSubagentActiveToolFilter = filter;
	}

	public setConsultAdvisorContribution(
		contribution: PromptContribution | undefined,
	): void {
		this.consultAdvisorContribution = contribution;
	}

	public setConveneCouncilContribution(
		contribution: PromptContribution | undefined,
	): void {
		this.conveneCouncilContribution = contribution;
	}

	private async resolveActiveToolNames(
		ctx: unknown,
	): Promise<readonly string[]> {
		const currentToolNames = this.pi.getActiveTools();
		const filteredToolNames =
			this.runSubagentActiveToolFilter === undefined
				? currentToolNames
				: await this.runSubagentActiveToolFilter(currentToolNames, ctx);
		if (!areStringArraysEqual(currentToolNames, filteredToolNames)) {
			this.pi.setActiveTools([...filteredToolNames]);
		}
		return filteredToolNames;
	}
}

async function resolvePromptContribution(
	contribution: PromptContribution | undefined,
	activeToolNames: readonly string[],
): Promise<string | undefined> {
	if (contribution?.requiredToolName !== undefined) {
		if (!activeToolNames.includes(contribution.requiredToolName)) {
			return undefined;
		}
	}
	return contribution?.buildPrompt?.() ?? contribution?.prompt;
}

function areStringArraysEqual(
	left: readonly string[],
	right: readonly string[],
): boolean {
	if (left.length !== right.length) {
		return false;
	}
	return left.every((value, index) => value === right[index]);
}

// ---------------------------------------------------------------------------
// Tool policy resolution (inlined from tool-policy)
// ---------------------------------------------------------------------------

function resolveToolPolicy(
	patterns: readonly string[],
	availableTools: readonly string[],
): { readonly tools: readonly string[] } | { readonly issue: string } {
	const resolved: string[] = [];
	const seen = new Set<string>();

	for (const pattern of patterns) {
		if (isFullWildcard(pattern)) {
			return { issue: "full wildcard * is not allowed" };
		}

		const matches = resolvePatternMatches(pattern, availableTools);
		if (matches.length === 0) {
			return {
				issue: `tool pattern ${pattern} did not match any available tool`,
			};
		}

		for (const tool of matches) {
			if (!seen.has(tool)) {
				seen.add(tool);
				resolved.push(tool);
			}
		}
	}

	return { tools: resolved };
}

function resolvePatternMatches(
	pattern: string,
	availableTools: readonly string[],
): string[] {
	if (pattern.includes("*")) {
		return matchWildcard(pattern, availableTools);
	}
	return availableTools.includes(pattern) ? [pattern] : [];
}

function matchWildcard(
	pattern: string,
	availableTools: readonly string[],
): string[] {
	const expression = new RegExp(
		`^${pattern.split("*").map(escapeRegexSegment).join(".*")}$`,
	);
	return availableTools.filter((tool) => expression.test(tool));
}

function escapeRegexSegment(segment: string): string {
	return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFullWildcard(pattern: string): boolean {
	return pattern.includes("*") && pattern.replaceAll("*", "").length === 0;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

interface SelectedAgentState {
	readonly cwd: string;
	readonly activeAgentId: string | null;
}

const SELECTED_AGENT_STATE_HASH_ENCODING = "hex";

async function writeSelectedAgentState(
	state: SelectedAgentState,
): Promise<void> {
	const stateDir = selectedAgentStateDir();
	await mkdir(stateDir, { recursive: true });
	await writeFile(
		selectedAgentStatePath(state.cwd),
		JSON.stringify(state, null, 2),
	);
}

async function readSelectedAgentState(
	cwd: string,
): Promise<
	| { readonly kind: "missing" }
	| { readonly kind: "valid"; readonly state: SelectedAgentState }
	| { readonly kind: "invalid"; readonly issue: string }
> {
	const stateFile = await readSelectedAgentStateFile(cwd);
	if (stateFile.kind === "missing") {
		return { kind: "missing" };
	}
	if (stateFile.kind === "invalid") {
		return stateFile;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stateFile.content);
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to parse selected-agent state: ${formatError(error)}`,
		};
	}

	const state = parseSelectedAgentState(parsed);
	if (state.kind === "invalid") {
		return state;
	}
	if (state.state.cwd !== cwd) {
		return {
			kind: "invalid",
			issue:
				"selected-agent state cwd does not match current working directory",
		};
	}

	return state;
}

function parseSelectedAgentState(
	state: unknown,
):
	| { readonly kind: "valid"; readonly state: SelectedAgentState }
	| { readonly kind: "invalid"; readonly issue: string } {
	const STATE_KEYS = ["cwd", "activeAgentId"] as const;
	if (!isRecord(state) || !hasOnlyKeys(state, STATE_KEYS)) {
		return {
			kind: "invalid",
			issue: "selected-agent state must contain only cwd and activeAgentId",
		};
	}

	const cwd = state[STATE_KEYS[0]];
	const activeAgentId = state[STATE_KEYS[1]];
	if (typeof cwd !== "string") {
		return {
			kind: "invalid",
			issue: "selected-agent state cwd must be a string",
		};
	}
	if (!(typeof activeAgentId === "string" || activeAgentId === null)) {
		return {
			kind: "invalid",
			issue: "selected-agent state activeAgentId must be a string or null",
		};
	}

	return { kind: "valid", state: { cwd, activeAgentId } };
}

async function readSelectedAgentStateFile(
	cwd: string,
): Promise<
	{ readonly kind: "missing" } | { readonly kind: "valid"; readonly content: string } | { readonly kind: "invalid"; readonly issue: string }
> {
	try {
		return {
			kind: "valid",
			content: await readFile(selectedAgentStatePath(cwd), "utf8"),
		};
	} catch (error) {
		if (!isFileNotFoundError(error)) {
			return {
				kind: "invalid",
				issue: `failed to read selected-agent state: ${formatError(error)}`,
			};
		}
	}

	try {
		return {
			kind: "valid",
			content: await readFile(legacySelectedAgentStatePath(cwd), "utf8"),
		};
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return { kind: "missing" };
		}
		return {
			kind: "invalid",
			issue: `failed to read selected-agent state: ${formatError(error)}`,
		};
	}
}

function selectedAgentStateDir(): string {
	return join(getSuiteExtensionDir("agent-selection"), STATE_SUBDIR);
}

function selectedAgentStatePath(cwd: string): string {
	return join(
		selectedAgentStateDir(),
		`${selectedAgentStateFileName(cwd)}.json`,
	);
}

function legacySelectedAgentStatePath(cwd: string): string {
	return join(
		getAgentDir(),
		"agent-selection",
		"state",
		`${selectedAgentStateFileName(cwd)}.json`,
	);
}

function selectedAgentStateFileName(cwd: string): string {
	return createHash("sha256")
		.update(cwd)
		.digest(SELECTED_AGENT_STATE_HASH_ENCODING);
}

// ---------------------------------------------------------------------------
// Suite storage helpers (inlined from agent-suite-storage)
// ---------------------------------------------------------------------------

const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const DEFAULT_AGENT_SUITE_DIR = "agent-suite";

function getAgentSuiteDir(): string {
	const configuredDir = env[AGENT_SUITE_DIR_ENV];
	if (configuredDir !== undefined && configuredDir.length > 0) {
		return expandHomeDirectory(configuredDir);
	}
	return join(getAgentDir(), DEFAULT_AGENT_SUITE_DIR);
}

function getSuiteExtensionDir(extensionDir: string): string {
	return join(getAgentSuiteDir(), extensionDir);
}

function expandHomeDirectory(path: string): string {
	if (path === "~") {
		return homedir();
	}
	if (path.startsWith("~/")) {
		return join(homedir(), path.slice(2));
	}
	return path;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function configFilePath(): string {
	return join(getExtensionDir(), CONFIG_FILE_NAME);
}

function getExtensionDir(): string {
	return join(getAgentDir(), "extensions", EXTENSION_DIR);
}

async function readConfig(): Promise<ExtensionConfig> {
	try {
		const content = await readFile(configFilePath(), "utf8");
		const parsed: unknown = JSON.parse(content);
		return parseConfig(parsed);
	} catch {
		return DEFAULT_CONFIG;
	}
}

function parseConfig(value: unknown): ExtensionConfig {
	if (!isRecord(value)) {
		return DEFAULT_CONFIG;
	}

	const enabled =
		typeof value.enabled === "boolean" ? value.enabled : DEFAULT_CONFIG.enabled;
	const command =
		typeof value.command === "string" && value.command.trim().length > 0
			? value.command.trim()
			: DEFAULT_CONFIG.command;
	const shortcut =
		value.shortcut === null
			? null
			: typeof value.shortcut === "string" && value.shortcut.trim().length > 0
				? value.shortcut.trim()
				: DEFAULT_CONFIG.shortcut;
	const footer = parseFooterConfig(value.footer);

	return { enabled, command, shortcut, footer };
}

function parseFooterConfig(value: unknown): FooterConfig {
	if (!isRecord(value)) {
		return DEFAULT_CONFIG.footer;
	}

	const enabled =
		typeof value.enabled === "boolean"
			? value.enabled
			: DEFAULT_CONFIG.footer.enabled;
	const statusKey =
		typeof value.statusKey === "string" && value.statusKey.trim().length > 0
			? value.statusKey.trim()
			: DEFAULT_CONFIG.footer.statusKey;
	const prefix =
		typeof value.prefix === "string"
			? sanitizeStatusText(value.prefix)
			: DEFAULT_CONFIG.footer.prefix;
	const colors: Record<string, string> = isRecord(value.colors)
		? Object.fromEntries(
				Object.entries(value.colors).filter(
					(entry): entry is [string, string] =>
						typeof entry[0] === "string" &&
						typeof entry[1] === "string" &&
						isHexColor(entry[1]),
				),
			)
		: { ...DEFAULT_CONFIG.footer.colors };
	const noneColor =
		typeof value.noneColor === "string" && isHexColor(value.noneColor)
			? value.noneColor
			: DEFAULT_CONFIG.footer.noneColor;

	return { enabled, statusKey, prefix, colors, noneColor };
}

// ---------------------------------------------------------------------------
// Footer/status helpers (from current-agent-status)
// ---------------------------------------------------------------------------

function formatAgentStatus(
	agentId: string | null,
	config: FooterConfig,
): string {
	const prefix = config.prefix;
	const safeAgentId = sanitizeStatusText(agentId ?? "none");
	const color = agentColor(agentId, config);
	return `${fg(color, prefix)}${fg(color, safeAgentId)}`;
}

function agentColor(agentId: string | null, config: FooterConfig): string {
	if (agentId === null) {
		return config.noneColor;
	}

	const exactMatch = config.colors[agentId];
	if (exactMatch !== undefined) {
		return exactMatch;
	}

	const lowerAgentId = agentId.toLowerCase();
	for (const [configuredAgentId, color] of Object.entries(config.colors)) {
		if (configuredAgentId.toLowerCase() === lowerAgentId) {
			return color;
		}
	}

	return hashColor(agentId);
}

function hashColor(text: string): string {
	const digest = createHash("sha256").update(text).digest();
	const hue = Math.round((digest[0] / 255) * 360);
	const saturation = 66 + (digest[1] % 10);
	const lightness = 62 + (digest[2] % 10);
	return hslToHex(hue, saturation, lightness);
}

function fg(hex: string, text: string): string {
	const [r, g, b] = hexToRgb(hex);
	return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function hexToRgb(hex: string): [number, number, number] {
	const normalized = hex.replace("#", "");
	return [
		Number.parseInt(normalized.slice(0, 2), 16),
		Number.parseInt(normalized.slice(2, 4), 16),
		Number.parseInt(normalized.slice(4, 6), 16),
	];
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
	const s = saturation / 100;
	const l = lightness / 100;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] = hslToRgbChannels(hue, c, x, m);
	return `#${[r, g, b]
		.map((channel) => channel.toString(16).padStart(2, "0"))
		.join("")}`;
}

function hslToRgbChannels(
	hue: number,
	c: number,
	x: number,
	m: number,
): [number, number, number] {
	let rgb: [number, number, number];
	if (hue < 60) rgb = [c, x, 0];
	else if (hue < 120) rgb = [x, c, 0];
	else if (hue < 180) rgb = [0, c, x];
	else if (hue < 240) rgb = [0, x, c];
	else if (hue < 300) rgb = [x, 0, c];
	else rgb = [c, 0, x];

	return rgb.map((channel) => Math.round((channel + m) * 255)) as [
		number,
		number,
		number,
	];
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function isHexColor(value: string): boolean {
	return /^#[\da-f]{6}$/i.test(value);
}

// ---------------------------------------------------------------------------
// Session replacement handoff
// ---------------------------------------------------------------------------

const SESSION_REPLACEMENT_HANDOFFS_PROPERTY =
	"__piHarnessMainAgentSelectionSessionReplacementHandoffs";

interface SessionReplacementHandoffCarrier {
	[SESSION_REPLACEMENT_HANDOFFS_PROPERTY]?: Map<string, string | null>;
}

type SessionReplacementHandoff =
	| { readonly found: false }
	| { readonly found: true; readonly activeAgentId: string | null };

interface SessionStartEventLike {
	readonly reason?: string;
}

interface SessionShutdownEventLike {
	readonly reason?: string;
	readonly targetSessionFile?: string;
}

function isSessionReplacementHandoffReason(
	reason: string | undefined,
): boolean {
	return reason === "new" || reason === "fork" || reason === "resume";
}

function captureSessionReplacementMainAgent(
	pi: ExtensionAPI,
	event: unknown,
	mainContext: MainAgentContext,
): void {
	const handoffKey = getSessionReplacementShutdownHandoffKey(
		event,
		mainContext,
	);
	if (handoffKey === undefined) {
		return;
	}

	const activeAgentId =
		getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent?.id ??
		null;
	getSessionReplacementHandoffStore().set(handoffKey, activeAgentId);
}

async function restoreSessionReplacementMainAgent(
	pi: ExtensionAPI,
	event: unknown,
	mainContext: MainAgentContext,
): Promise<boolean> {
	const handoffKey = getSessionReplacementStartHandoffKey(event, mainContext);
	if (handoffKey === undefined) {
		return false;
	}

	const handoff = consumeSessionReplacementHandoff(handoffKey);
	if (!handoff.found) {
		return false;
	}
	if (handoff.activeAgentId === null) {
		getAgentRuntimeComposition(pi).clearMainAgentContribution();
		return true;
	}

	const agents = await loadSelectableAgents();
	const agent = agents.find(
		(candidate) => candidate.id === handoff.activeAgentId,
	);
	if (agent === undefined) {
		reportIssue(
			mainContext,
			`selected agent ${handoff.activeAgentId} was not found`,
		);
		getAgentRuntimeComposition(pi).clearMainAgentContribution();
		return true;
	}

	await applyAgentSelection(pi, mainContext, agent);
	return true;
}

function getSessionReplacementShutdownHandoffKey(
	event: unknown,
	mainContext: MainAgentContext,
): string | undefined {
	const shutdownEvent = event as SessionShutdownEventLike;
	if (!isSessionReplacementHandoffReason(shutdownEvent.reason)) {
		return undefined;
	}
	return (
		shutdownEvent.targetSessionFile ??
		mainContext.sessionManager.getSessionFile() ??
		normalizeCwd(mainContext.cwd)
	);
}

function getSessionReplacementStartHandoffKey(
	event: unknown,
	mainContext: MainAgentContext,
): string | undefined {
	const startEvent = event as SessionStartEventLike;
	if (!isSessionReplacementHandoffReason(startEvent.reason)) {
		return undefined;
	}
	return (
		mainContext.sessionManager.getSessionFile() ?? normalizeCwd(mainContext.cwd)
	);
}

function getSessionReplacementHandoffStore(): Map<string, string | null> {
	const carrier = globalThis as SessionReplacementHandoffCarrier;
	const existing = carrier[SESSION_REPLACEMENT_HANDOFFS_PROPERTY];
	if (existing !== undefined) {
		return existing;
	}

	const store = new Map<string, string | null>();
	carrier[SESSION_REPLACEMENT_HANDOFFS_PROPERTY] = store;
	return store;
}

function consumeSessionReplacementHandoff(
	cwd: string,
): SessionReplacementHandoff {
	const store = getSessionReplacementHandoffStore();
	if (!store.has(cwd)) {
		return { found: false };
	}

	const activeAgentId = store.get(cwd) ?? null;
	store.delete(cwd);
	return { found: true, activeAgentId };
}

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

interface MainAgentContext {
	readonly cwd: string;
	readonly hasUI?: boolean;
	readonly sessionManager: {
		getSessionFile(): string | undefined;
	};
	readonly ui: {
		custom?<T>(
			factory: (
				tui: MainAgentSelectorTui,
				theme: MainAgentSelectorTheme,
				keybindings: MainAgentSelectorKeybindings,
				done: (result: T) => void,
			) => Component | Promise<Component>,
		): Promise<T>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
	readonly modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
	};
}

interface MainAgentSelectorTui {
	requestRender(): void;
}

interface MainAgentSelectorTheme {
	fg(color: string, text: string): string;
}

type MainAgentSelectorKeybinding = Extract<
	Keybinding,
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.confirm"
	| "tui.select.cancel"
>;

interface MainAgentSelectorKeybindings {
	matches(data: string, keybinding: MainAgentSelectorKeybinding): boolean;
}

// ---------------------------------------------------------------------------
// Searchable agent selector UI
// ---------------------------------------------------------------------------

const NO_AGENT_LABEL = "No agent";
const NO_AGENT_ARGUMENT = "none";
const NO_AGENT_VALUE = "__none__";

interface SearchableAgentSelectorOptions {
	readonly options: readonly SelectItem[];
	readonly currentAgentId: string | null;
	readonly keybindings: MainAgentSelectorKeybindings;
	readonly theme: MainAgentSelectorTheme;
	readonly onSelect: (value: string) => void;
	readonly onCancel: () => void;
}

class SearchableAgentSelector implements Component, Focusable {
	private readonly options: readonly SelectItem[];
	private readonly keybindings: MainAgentSelectorKeybindings;
	private readonly searchInput = new Input();
	private readonly theme: MainAgentSelectorTheme;
	private readonly onSelect: (value: string) => void;
	private readonly onCancel: () => void;
	private selectList: SelectList;
	private filteredOptions: readonly SelectItem[];
	private selectedValue: string;
	private readonly maxVisibleOptions: number;
	private _focused = false;

	constructor(config: SearchableAgentSelectorOptions) {
		this.options = config.options;
		this.keybindings = config.keybindings;
		this.theme = config.theme;
		this.onSelect = config.onSelect;
		this.onCancel = config.onCancel;
		this.filteredOptions = config.options;
		this.selectedValue = config.currentAgentId ?? NO_AGENT_VALUE;
		this.maxVisibleOptions = Math.min(config.options.length, 10);
		this.selectList = this.createSelectList(this.filteredOptions);
		this.syncSelectedIndex();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	render(width: number): string[] {
		const lines = [
			truncateToWidth(
				this.theme.fg(
					"dim",
					"Type to search agents • navigate • select • cancel",
				),
				width,
			),
			...this.searchInput.render(width),
		];
		if (this.filteredOptions.length === 0) {
			lines.push(
				truncateToWidth(
					this.theme.fg("warning", "  No matching agents"),
					width,
				),
			);
			return lines;
		}

		lines.push(...this.selectList.render(width));
		return lines;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.confirmSelection();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}

		const previousQuery = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		if (this.searchInput.getValue() !== previousQuery) {
			this.applySearch();
		}
	}

	invalidate(): void {
		this.searchInput.invalidate();
		this.selectList.invalidate();
	}

	private applySearch(): void {
		const query = this.searchInput.getValue().toLowerCase();
		this.filteredOptions =
			query.length === 0
				? this.options
				: this.options.filter((option) =>
						option.label.toLowerCase().includes(query),
					);
		this.selectList = this.createSelectList(this.filteredOptions);
		this.syncSelectedIndex();
	}

	private syncSelectedIndex(): void {
		const selectedIndex = this.filteredOptions.findIndex(
			(option) => option.value === this.selectedValue,
		);
		if (selectedIndex >= 0) {
			this.selectList.setSelectedIndex(selectedIndex);
			return;
		}

		const firstOption = this.filteredOptions[0];
		if (firstOption !== undefined) {
			this.selectedValue = firstOption.value;
			this.selectList.setSelectedIndex(0);
		}
	}

	private moveSelection(direction: -1 | 1): void {
		if (this.filteredOptions.length === 0) {
			return;
		}

		const currentIndex = this.filteredOptions.findIndex(
			(option) => option.value === this.selectedValue,
		);
		const startIndex = currentIndex >= 0 ? currentIndex : 0;
		const nextIndex =
			(startIndex + direction + this.filteredOptions.length) %
			this.filteredOptions.length;
		const nextOption = this.filteredOptions[nextIndex];
		if (nextOption === undefined) {
			return;
		}

		this.selectedValue = nextOption.value;
		this.selectList.setSelectedIndex(nextIndex);
	}

	private confirmSelection(): void {
		if (this.filteredOptions.length === 0) {
			return;
		}
		this.onSelect(this.selectedValue);
	}

	private createSelectList(options: readonly SelectItem[]): SelectList {
		return new SelectList([...options], this.maxVisibleOptions, {
			selectedPrefix: (text: string) => this.theme.fg("accent", text),
			selectedText: (text: string) => this.theme.fg("accent", text),
			description: (text: string) => this.theme.fg("muted", text),
			scrollInfo: (text: string) => this.theme.fg("dim", text),
			noMatch: (text: string) => this.theme.fg("warning", text),
		});
	}
}

// ---------------------------------------------------------------------------
// Core agent selection logic
// ---------------------------------------------------------------------------

async function loadSelectableAgents(): Promise<AgentDefinition[]> {
	const agents = await loadAgentDefinitions();
	return agents.filter(
		(agent) => agent.type === "main" || agent.type === "both",
	);
}

async function selectMainAgent(
	pi: ExtensionAPI,
	ctx: MainAgentContext,
	explicitAgentId: string | undefined,
	config: ExtensionConfig,
): Promise<void> {
	const agents = await loadSelectableAgents();
	const selectedAgentId =
		explicitAgentId ?? (await promptForAgent(pi, ctx, agents));
	if (selectedAgentId === undefined) {
		return;
	}
	if (selectedAgentId === null) {
		await selectNoMainAgent(pi, ctx, config);
		return;
	}

	const agent = agents.find((candidate) => candidate.id === selectedAgentId);
	if (agent === undefined) {
		reportIssue(ctx, `agent ${selectedAgentId} was not found`);
		return;
	}

	const normalizedCwd = normalizeCwd(ctx.cwd);
	const applied = await applyAgentSelection(pi, ctx, agent);
	if (!applied) {
		await writeSelectedAgentState({
			cwd: normalizedCwd,
			activeAgentId: null,
		});
		return;
	}

	await writeSelectedAgentState({
		cwd: normalizedCwd,
		activeAgentId: agent.id,
	});
	refreshFooterStatus(ctx, pi, config);
}

async function selectNoMainAgent(
	pi: ExtensionAPI,
	ctx: MainAgentContext,
	config: ExtensionConfig,
): Promise<void> {
	const normalizedCwd = normalizeCwd(ctx.cwd);
	getAgentRuntimeComposition(pi).clearMainAgentContribution();

	await writeSelectedAgentState({
		cwd: normalizedCwd,
		activeAgentId: null,
	});
	refreshFooterStatus(ctx, pi, config);
}

async function applyAgentSelection(
	pi: ExtensionAPI,
	ctx: MainAgentContext,
	agent: AgentDefinition,
): Promise<boolean> {
	const resolvedTools = resolveMainAgentTools(pi, agent);
	if ("issue" in resolvedTools) {
		clearMainAgentSelection(pi);
		reportIssue(ctx, resolvedTools.issue);
		return false;
	}

	if (agent.model?.id !== undefined) {
		const model = resolveModel(ctx, agent.model.id);
		if (model === undefined) {
			clearMainAgentSelection(pi);
			reportIssue(ctx, `model ${agent.model.id} was not found`);
			return false;
		}

		const modelApplied = await pi.setModel(model);
		if (!modelApplied) {
			clearMainAgentSelection(pi);
			reportIssue(ctx, `model ${agent.model.id} could not be applied`);
			return false;
		}
	}

	if (agent.model?.thinking !== undefined) {
		pi.setThinkingLevel(agent.model.thinking);
	}

	getAgentRuntimeComposition(pi).setMainAgentContribution({
		prompt: agent.prompt,
		agent: {
			id: agent.id,
			...(resolvedTools.tools !== undefined
				? { tools: resolvedTools.tools }
				: {}),
			...(agent.agents !== undefined ? { agents: agent.agents } : {}),
		},
		...(resolvedTools.tools !== undefined
			? { tools: resolvedTools.tools }
			: {}),
	});
	return true;
}

function resolveMainAgentTools(
	pi: ExtensionAPI,
	agent: AgentDefinition,
): { readonly tools?: readonly string[] } | { readonly issue: string } {
	if (agent.tools === undefined) {
		return {};
	}

	const availableToolNames = pi.getAllTools().map((tool) => tool.name);
	const resolved = resolveToolPolicy(agent.tools, availableToolNames);
	if ("issue" in resolved) {
		return resolved;
	}

	return { tools: resolved.tools };
}

function resolveModel(
	ctx: MainAgentContext,
	modelId: string,
): Model<Api> | undefined {
	const separatorIndex = modelId.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === modelId.length - 1) {
		return undefined;
	}

	const provider = modelId.slice(0, separatorIndex);
	const id = modelId.slice(separatorIndex + 1);
	return ctx.modelRegistry.find(provider, id);
}

function clearMainAgentSelection(pi: ExtensionAPI): void {
	getAgentRuntimeComposition(pi).clearMainAgentContribution();
}

async function promptForAgent(
	pi: ExtensionAPI,
	ctx: MainAgentContext,
	agents: readonly AgentDefinition[],
): Promise<string | null | undefined> {
	if (ctx.hasUI === false || ctx.ui.custom === undefined) {
		reportIssue(ctx, "agent selection UI is unavailable");
		return undefined;
	}

	const currentAgentId =
		getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent?.id ??
		null;
	const options: SelectItem[] = [
		{ value: NO_AGENT_VALUE, label: NO_AGENT_LABEL },
		...agents.map((agent) => ({
			value: agent.id,
			label: `${agent.id} — ${agent.description}`,
		})),
	];
	const selected = await ctx.ui.custom<string | undefined>(
		(tui, theme, keybindings, done) => {
			const selector = new SearchableAgentSelector({
				options,
				currentAgentId,
				keybindings,
				theme,
				onSelect: (value) => done(value),
				onCancel: () => done(undefined),
			});

			return {
				get focused(): boolean {
					return selector.focused;
				},
				set focused(value: boolean) {
					selector.focused = value;
				},
				render(width: number): string[] {
					return selector.render(width);
				},
				invalidate(): void {
					selector.invalidate();
				},
				handleInput(data: string): void {
					selector.handleInput(data);
					tui.requestRender();
				},
			};
		},
	);
	if (selected === undefined) {
		return undefined;
	}

	return selected === NO_AGENT_VALUE ? null : selected;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function isChildSubagentProcess(): boolean {
	return process.env.PI_SUBAGENT_AGENT_ID !== undefined;
}

async function restoreSelectedMainAgent(
	pi: ExtensionAPI,
	mainContext: MainAgentContext,
): Promise<void> {
	const composition = getAgentRuntimeComposition(pi);
	const normalizedCwd = normalizeCwd(mainContext.cwd);
	const agents = await loadSelectableAgents();
	const state = await readSelectedAgentState(normalizedCwd);

	if (state.kind === "missing") {
		composition.clearMainAgentContribution();
		return;
	}
	if (state.kind === "invalid") {
		composition.clearMainAgentContribution();
		reportIssue(mainContext, state.issue);
		return;
	}
	if (state.state.activeAgentId === null) {
		composition.clearMainAgentContribution();
		return;
	}

	const agent = agents.find(
		(candidate) => candidate.id === state.state.activeAgentId,
	);
	if (agent === undefined) {
		reportIssue(
			mainContext,
			`selected agent ${state.state.activeAgentId} was not found`,
		);
		composition.clearMainAgentContribution();
		return;
	}

	await applyAgentSelection(pi, mainContext, agent);
}

// ---------------------------------------------------------------------------
// Footer status refresh
// ---------------------------------------------------------------------------

async function refreshFooterStatus(
	ctx: unknown,
	pi: ExtensionAPI,
	config: ExtensionConfig,
): Promise<void> {
	if (!config.footer.enabled) {
		return;
	}

	const composition = getAgentRuntimeComposition(pi);
	const contribution = composition.getMainAgentContribution();
	const agentId = contribution?.agent?.id ?? null;

	const statusCtx = ctx as StatusContext | undefined;
	if (statusCtx === undefined || statusCtx.hasUI === false) {
		return;
	}

	statusCtx.ui.setStatus(
		config.footer.statusKey,
		formatAgentStatus(agentId, config.footer),
	);
}

function setFooterStatus(
	ctx: StatusContext | undefined,
	agentId: string | null,
	config: FooterConfig,
): void {
	if (ctx === undefined || ctx.hasUI === false) {
		return;
	}

	ctx.ui.setStatus(config.statusKey, formatAgentStatus(agentId, config));
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function mainAgentSelection(
	pi: ExtensionAPI,
): Promise<void> {
	const config = await readConfig();
	if (!config.enabled) {
		return;
	}

	const composition = getAgentRuntimeComposition(pi);
	let activeCtx: StatusContext | undefined;

	// Register command
	pi.registerCommand(config.command, {
		description: "Select the main agent for this working directory",
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			if (trimmedArgs.toLowerCase() === NO_AGENT_ARGUMENT) {
				await selectNoMainAgent(pi, ctx as MainAgentContext, config);
				return;
			}

			await selectMainAgent(
				pi,
				ctx as MainAgentContext,
				trimmedArgs || undefined,
				config,
			);
		},
	});

	// Register configurable shortcut
	if (config.shortcut !== null) {
		pi.registerShortcut(config.shortcut as Parameters<typeof pi.registerShortcut>[0], {
			description: "Select the main agent",
			handler: async (ctx) => {
				await selectMainAgent(pi, ctx as MainAgentContext, undefined, config);
			},
		});
	}

	// Session lifecycle
	pi.on("session_start", async (event, ctx) => {
		activeCtx = ctx as StatusContext;
		if (isChildSubagentProcess()) {
			return;
		}

		const mainContext = ctx as MainAgentContext;

		if (await restoreSessionReplacementMainAgent(pi, event, mainContext)) {
			refreshFooterStatus(ctx, pi, config);
			return;
		}

		const startEvent = event as SessionStartEventLike;
		const shouldRestore =
			startEvent.reason === "startup" ||
			startEvent.reason === "reload" ||
			startEvent.reason === "resume";

		if (!shouldRestore) {
			refreshFooterStatus(ctx, pi, config);
			return;
		}

		await restoreSelectedMainAgent(pi, mainContext);
		refreshFooterStatus(ctx, pi, config);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const statusCtx = ctx as StatusContext;
		if (config.footer.enabled && statusCtx.hasUI !== false) {
			statusCtx.ui.setStatus(config.footer.statusKey, undefined);
		}
		if (activeCtx === statusCtx) {
			activeCtx = undefined;
		}

		const mainContext = ctx as MainAgentContext;
		if (isChildSubagentProcess()) {
			return;
		}

		captureSessionReplacementMainAgent(pi, _event, mainContext);
		markAgentRuntimeCompositionStale(pi);
	});

	// React to runtime composition changes for footer updates
	const maybeEventBus = pi.events as unknown as {
		on?: (eventName: string, listener: () => void) => unknown;
	};
	maybeEventBus.on?.(MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT, () => {
		if (config.footer.enabled && activeCtx !== undefined) {
			const contribution = composition.getMainAgentContribution();
			const agentId = contribution?.agent?.id ?? null;
			setFooterStatus(activeCtx, agentId, config.footer);
		}
	});
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function normalizeCwd(cwd: string): string {
	return resolve(cwd);
}

function reportIssue(ctx: MainAgentContext, issue: string): void {
	if (ctx.hasUI === false) {
		return;
	}
	ctx.ui.notify(`[agent-selection] ${issue}`, "warning");
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isFileNotFoundError(error: unknown): boolean {
	if (!isRecord(error)) {
		return false;
	}
	const { code } = error as { code?: unknown };
	return code === "ENOENT";
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	allowedKeys: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface StatusContext {
	readonly cwd: string;
	readonly hasUI?: boolean;
	readonly ui: {
		readonly theme?: { fg(color: string, text: string): string };
		setStatus(key: string, text: string | undefined): void;
	};
}
