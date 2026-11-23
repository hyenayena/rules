import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import type {ModuleDirs, RulesLayout} from '../../../src/api.js';
import {type Expansion, expandDetailed, type Problem, type RulesScope, statKey} from './engine.js';
import {loadProjectReader, type ProjectReader} from './deps/project.js';

export const INDEX_VERSION = 1;
export const INDEX_MAX_AGE_MS = 15_000;
export const INDEX_MAX_BYTES = 64 * 1024 * 1024;
export const INDEX_MAX_ENTRIES = 1_000_000;
const INDEX_FILE = 'index.json';
const LAYOUT_TTL_MS = 5000;

export const rulesDataDirFor = (moduleDataDir: string): string => path.join(path.dirname(moduleDataDir), 'rules');

export type RulesLists = Expansion & {builtAt: number; persisted: boolean};

export type RulesIndexReader = {
	get(o?: {maxAgeMs?: number; force?: boolean}): Promise<RulesLists>;
	layout(): Promise<RulesLayout | undefined>;
	setLayoutSource(source: () => Promise<RulesLayout>): void;
	setProjects(reader: ProjectReader | undefined): void;
};

type Stored = {
	v: number;
	builtAt: number;
	layout: RulesLayout;
	watch: Array<[string, string]>;
	problems: Problem[];
	truncated: boolean;
} & Pick<Expansion, 'denyRead' | 'askRead' | 'denyWrite' | 'askWrite' | 'denyExport' | 'rulesFiles'>;

const LIST_KEYS = ['denyRead', 'askRead', 'denyWrite', 'askWrite', 'denyExport', 'rulesFiles'] as const;

const isAbs = (v: unknown): v is string => typeof v === 'string' && path.isAbsolute(v) && path.normalize(v) === v && !v.includes('\0');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseLayout(raw: unknown): RulesLayout | undefined {
	if (!isRecord(raw) || !Array.isArray(raw.modules)) return undefined;
	if (raw.root !== undefined && !isAbs(raw.root)) return undefined;
	const modules: ModuleDirs[] = [];
	for (const m of raw.modules as unknown[]) {
		if (!isRecord(m) || typeof m.name !== 'string' || !isAbs(m.codeDir) || !isAbs(m.dataDir)) return undefined;
		modules.push({name: m.name, codeDir: m.codeDir, dataDir: m.dataDir});
	}
	return {...(typeof raw.root === 'string' && {root: raw.root}), modules};
}

export function parseStored(text: string): Stored | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(raw) || raw.v !== INDEX_VERSION || typeof raw.builtAt !== 'number' || typeof raw.truncated !== 'boolean') return undefined;
	let total = 0;
	const lists: Partial<Record<(typeof LIST_KEYS)[number], string[]>> = {};
	for (const key of LIST_KEYS) {
		const list = raw[key];
		if (!Array.isArray(list) || !list.every(isAbs)) return undefined;
		total += list.length;
		lists[key] = list as string[];
	}
	if (total > INDEX_MAX_ENTRIES) return undefined;
	const layout = parseLayout(raw.layout);
	if (!layout || !Array.isArray(raw.watch) || !Array.isArray(raw.problems)) return undefined;
	const watch: Array<[string, string]> = [];
	for (const w of raw.watch as unknown[]) {
		if (!Array.isArray(w) || !isAbs(w[0]) || typeof w[1] !== 'string') return undefined;
		watch.push([w[0], w[1]]);
	}
	const problems: Problem[] = [];
	for (const p of raw.problems as unknown[]) {
		if (!isRecord(p) || typeof p.file !== 'string' || typeof p.problem !== 'string') return undefined;
		problems.push({file: p.file, problem: p.problem, ...(typeof p.line === 'number' && {line: p.line})});
	}
	return {v: INDEX_VERSION, builtAt: raw.builtAt, layout, watch, problems, truncated: raw.truncated, ...(lists as Pick<Stored, (typeof LIST_KEYS)[number]>)};
}

async function keyOf(p: string): Promise<string> {
	try {
		const info = await lstat(p);
		return info.isDirectory() ? `d${info.mtimeMs}` : statKey(info);
	} catch {
		return 'none';
	}
}

async function readIndexFile(file: string): Promise<{key: string; stored?: Stored} | undefined> {
	let info;
	try {
		info = await lstat(file);
	} catch {
		return undefined;
	}
	const key = statKey(info);
	if (!info.isFile() || info.size > INDEX_MAX_BYTES) return {key};
	try {
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stored = parseStored(await handle.readFile('utf8'));
			return {key, ...(stored && {stored})};
		} finally {
			await handle.close();
		}
	} catch {
		return {key};
	}
}

async function writeIndexFile(dir: string, text: string): Promise<boolean> {
	if (Buffer.byteLength(text) > INDEX_MAX_BYTES) return false;
	let tmp: string | undefined;
	try {
		const info = await lstat(dir).catch(() => undefined);
		if (info === undefined) await mkdir(dir, {mode: 0o700});
		else if (!info.isDirectory()) return false;
		tmp = path.join(dir, `.${INDEX_FILE}.${randomBytes(6).toString('hex')}.tmp`);
		const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try {
			await handle.writeFile(text);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tmp, path.join(dir, INDEX_FILE));
		return true;
	} catch {
		if (tmp !== undefined) await unlink(tmp).catch(() => undefined);
		return false;
	}
}

type Memo = {lists: RulesLists; watch: Array<[string, string]>; layout: RulesLayout};

const readers = new Map<string, RulesIndexReader>();

export function resetIndexMemo(): void {
	readers.clear();
}

export type IndexOptions = {root?: string; now?: () => number; maxEntries?: number};

export function rulesIndex(moduleDataDir: string, opts: IndexOptions = {}): RulesIndexReader {
	const dir = rulesDataDirFor(moduleDataDir);
	const memoKey = `${dir}\0${opts.root ?? ''}`;
	const known = readers.get(memoKey);
	if (known) return known;
	const reader = createIndex(moduleDataDir, dir, opts);
	readers.set(memoKey, reader);
	return reader;
}

function createIndex(moduleDataDir: string, dir: string, opts: IndexOptions): RulesIndexReader {
	const file = path.join(dir, INDEX_FILE);
	const now = opts.now ?? Date.now;
	let memo: Memo | undefined;
	let fileKey: string | undefined;
	let source: (() => Promise<RulesLayout>) | undefined;
	let layoutCache: {at: number; value: RulesLayout} | undefined;
	let projects: ProjectReader | undefined;
	let projectsLoaded = false;
	let building: Promise<RulesLists> | undefined;

	async function loadDisk(): Promise<void> {
		const read = await readIndexFile(file);
		if (read === undefined) return;
		if (read.key === fileKey) return;
		fileKey = read.key;
		if (read.stored === undefined) return;
		const {layout, watch, v, ...rest} = read.stored;
		memo = {lists: {...rest, persisted: true}, watch, layout};
	}

	async function currentLayout(fresh: boolean): Promise<RulesLayout | undefined> {
		if (source !== undefined) {
			if (!fresh && layoutCache && now() - layoutCache.at < LAYOUT_TTL_MS) return layoutCache.value;
			try {
				const value = await source();
				layoutCache = {at: now(), value};
				return value;
			} catch {
				return layoutCache?.value ?? memo?.layout;
			}
		}
		await loadDisk();
		return memo?.layout;
	}

	async function changed(m: Memo): Promise<boolean> {
		for (const [p, key] of m.watch) if ((await keyOf(p)) !== key) return true;
		return false;
	}

	async function build(): Promise<RulesLists> {
		if (!projectsLoaded) {
			projectsLoaded = true;
			projects ??= await loadProjectReader(moduleDataDir);
		}
		const layout = (await currentLayout(true)) ?? {modules: []};
		const root = opts.root ?? layout.root;
		const scope: RulesScope = {
			roots: root === undefined ? [] : [root],
			projects: async () => projects?.read(),
			...(projects?.rulesFile && {rulesFile: (n: string) => projects?.rulesFile?.(n)}),
			modules: async () => layout.modules,
		};
		const {value, keys, bases} = await expandDetailed(scope, opts.maxEntries === undefined ? {} : {maxEntries: opts.maxEntries});
		const builtAt = now();
		const access = await projects?.read().catch(() => undefined);
		const extra = new Set<string>(layout.modules.map(m => m.codeDir));
		if (root !== undefined) extra.add(root);
		for (const b of bases) if (b.dataRules === undefined) extra.add(b.dir);
		for (const r of access?.roots ?? []) extra.add(r);
		for (const [f] of keys) extra.add(path.dirname(f));
		const sample = projects?.rulesFile?.('a');
		if (sample !== undefined) extra.add(path.dirname(sample));
		const watch: Array<[string, string]> = [];
		for (const [f, k] of keys) watch.push([f, k.replace(/:[01]$/, '')]);
		for (const p of extra) watch.push([p, await keyOf(p)]);
		const stored: Stored = {
			v: INDEX_VERSION,
			builtAt,
			layout: {...(layout.root !== undefined && {root: layout.root}), modules: layout.modules.map(m => ({name: m.name, codeDir: m.codeDir, dataDir: m.dataDir}))},
			watch,
			...value,
		};
		const persisted = await writeIndexFile(dir, JSON.stringify(stored));
		if (persisted) fileKey = (await readIndexFile(file))?.key;
		const lists: RulesLists = {...value, builtAt, persisted};
		memo = {lists, watch, layout: stored.layout};
		return lists;
	}

	async function rebuild(): Promise<RulesLists> {
		while (building) await building.catch(() => undefined);
		building = build();
		try {
			return await building;
		} finally {
			building = undefined;
		}
	}

	return {
		async get(o = {}) {
			if (o.force) return rebuild();
			if (building) return building;
			await loadDisk();
			if (memo === undefined) return rebuild();
			if (o.maxAgeMs !== undefined && now() - memo.lists.builtAt > o.maxAgeMs) return rebuild();
			if (await changed(memo)) return rebuild();
			return memo.lists;
		},
		layout: () => currentLayout(false),
		setLayoutSource(fn) {
			source = fn;
			layoutCache = undefined;
		},
		setProjects(reader) {
			projects = reader;
			projectsLoaded = true;
		},
	};
}
