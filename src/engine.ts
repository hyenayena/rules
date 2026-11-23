import {constants, type Stats} from 'node:fs';
import {lstat, open, readdir, realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import type {ModuleDirs} from '../../../src/api.js';
import type {ProjectAccess} from './deps/project.js';
import type {RulesIndexReader} from './index-store.js';

export const RULES_FILE = '.yenarules';
export const SECTIONS = ['deny read', 'ask read', 'deny write', 'ask write', 'deny export'] as const;
export type Section = (typeof SECTIONS)[number];
export type Level = 'deny' | 'ask' | 'free';

export const RULES_MAX_BYTES = 64 * 1024;
export const RULES_MAX_LINES = 2000;
export const EXPAND_MAX_ENTRIES = 200_000;
const SKIPPED_DIR = 'node_modules';
const OPAQUE_DIR = '.yena';
const COUNT = SECTIONS.length;
const DENY_READ = 0;
const DENY_EXPORT = 4;
const MODULES_DIR = 'modules';
const MANIFEST = 'yena.json';

export type Problem = {file: string; line?: number; problem: string};

type Line = {neg: boolean; folderOnly: boolean; anchored: boolean; re: RegExp; prefix: string[]};
type Sections = Record<Section, Line[]>;
export type ParseResult =
	| {ok: true; sections: Sections; data: Sections; declared: ReadonlySet<Section>}
	| {ok: false; problem: string; line?: number};

class PatternError extends Error {}

const emptySections = (): Sections => ({'deny read': [], 'ask read': [], 'deny write': [], 'ask write': [], 'deny export': []});

const escapeRe = (c: string): string => c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

function globSegment(seg: string): string {
	let src = '';
	for (let i = 0; i < seg.length; i++) {
		const c = seg[i] as string;
		if (c === '\\') {
			if (i + 1 >= seg.length) throw new PatternError('a pattern cannot end with a backslash');
			src += escapeRe(seg[++i] as string);
		} else if (c === '*') {
			while (seg[i + 1] === '*') i++;
			src += '[^/]*';
		} else if (c === '?') {
			src += '[^/]';
		} else if (c === '[') {
			let j = i + 1;
			let neg = false;
			if (seg[j] === '!' || seg[j] === '^') {
				neg = true;
				j++;
			}
			let body = '';
			let first = true;
			for (; j < seg.length; j++) {
				const d = seg[j] as string;
				if (d === ']' && !first) break;
				first = false;
				body += d === '\\' || d === '[' || d === ']' || d === '^' ? `\\${d}` : d;
			}
			if (j >= seg.length || body === '') throw new PatternError('a "[" has no closing "]"');
			src += `[${neg ? '^' : ''}${body}]`;
			i = j;
		} else {
			src += escapeRe(c);
		}
	}
	return src;
}

type Compiled = Line & {data: boolean};

function compileLine(text: string, dataAllowed: boolean): Compiled {
	let p = text;
	let neg = false;
	if (!p.startsWith('\\#') && !p.startsWith('\\!') && p.startsWith('!')) {
		neg = true;
		p = p.slice(1);
	}
	let data = false;
	if (p.startsWith('@')) {
		if (!dataAllowed) throw new PatternError('"@" (the module\'s data folder) is valid only in a module\'s root .yenarules');
		if (p.startsWith('@/')) throw new PatternError('"@" is followed by a path relative to the data folder, not by "/"');
		data = true;
		p = p.slice(1);
	}
	if (p === '') throw new PatternError('the pattern is empty');
	const folderOnly = p.endsWith('/');
	let anchored = data || p.startsWith('/');
	const segs = p.split('/').filter(s => s !== '');
	if (segs.length === 0) throw new PatternError('the pattern is empty');
	if (segs.length > 1) anchored = true;
	if (segs.some(s => s === '.' || s === '..')) throw new PatternError('"." and ".." segments are not allowed');
	for (const s of segs) if (s !== '**' && s.includes('**')) throw new PatternError('"**" must be a whole path segment');
	const flat: string[] = [];
	for (const s of segs) if (!(s === '**' && flat[flat.length - 1] === '**')) flat.push(s);
	if (!anchored) {
		const only = flat[0] as string;
		return {neg, folderOnly, anchored, re: new RegExp(`^${only === '**' ? '.*' : globSegment(only)}$`, 's'), prefix: [], data};
	}
	let src = '';
	let needSlash = false;
	flat.forEach((s, i) => {
		const first = i === 0;
		const last = i === flat.length - 1;
		if (s === '**') {
			if (first && last) src += '.*';
			else if (first) src += '(?:.*/)?';
			// "dir/**" in a data line covers the folder itself, like the old export patterns
			else if (last) src += data ? '(?:/.*)?' : '/.*';
			else src += '/(?:.*/)?';
			needSlash = false;
			return;
		}
		if (needSlash) src += '/';
		src += globSegment(s);
		needSlash = true;
	});
	const prefix: string[] = [];
	for (const s of flat) {
		if (s === '**' || /[*?[\\]/.test(s)) break;
		prefix.push(s);
	}
	return {neg, folderOnly, anchored, re: new RegExp(`^${src}$`, 's'), prefix, data};
}

export function parseRules(text: string, opts: {dataAllowed?: boolean} = {}): ParseResult {
	const lines = text.split('\n');
	if (lines.length > RULES_MAX_LINES + 1) return {ok: false, problem: `more than ${RULES_MAX_LINES} lines`};
	const sections = emptySections();
	const data = emptySections();
	const declared = new Set<Section>();
	let current: Section | undefined;
	for (let i = 0; i < lines.length; i++) {
		const n = i + 1;
		const t = (lines[i] as string).replace(/[ \r]+$/, '');
		if (t.includes('\0')) return {ok: false, problem: 'a NUL character', line: n};
		if (t === '' || t.startsWith('#')) continue;
		const header = /^\[([^\]]*)\]$/.exec(t);
		if (header) {
			const name = header[1] as string;
			if (!(SECTIONS as readonly string[]).includes(name)) return {ok: false, problem: 'unknown section header', line: n};
			current = name as Section;
			declared.add(current);
			continue;
		}
		if (current === undefined) return {ok: false, problem: 'a pattern before any section header', line: n};
		try {
			const {data: isData, ...line} = compileLine(t, opts.dataAllowed === true);
			(isData ? data : sections)[current].push(line);
		} catch (error) {
			if (error instanceof PatternError) return {ok: false, problem: error.message, line: n};
			throw error;
		}
	}
	return {ok: true, sections, data, declared};
}

function lineMatches(line: Line, segs: string[], isDir: boolean): boolean {
	for (let k = 1; k <= segs.length; k++) {
		if (line.folderOnly && k === segs.length && !isDir) continue;
		if (line.re.test(line.anchored ? segs.slice(0, k).join('/') : (segs[k - 1] as string))) return true;
	}
	return false;
}

const lineMatchesEntry = (line: Line, segs: string[], isDir: boolean): boolean => {
	if (line.folderOnly && !isDir) return false;
	return line.re.test(line.anchored ? segs.join('/') : (segs[segs.length - 1] as string));
};

function decide(lines: Line[], segs: string[], isDir: boolean): boolean {
	let inside = false;
	for (const line of lines) if (lineMatches(line, segs, isDir)) inside = !line.neg;
	return inside;
}

type Loaded =
	| {kind: 'none'}
	| {kind: 'ok'; sections: Sections; data: Sections; declared: ReadonlySet<Section>}
	| {kind: 'bad'; problem: string; line?: number};
type Entry = {key: string; loaded: Loaded};

const parsed = new Map<string, Entry>();
const PARSED_MAX = 4096;

export const statKey = (info: Stats): string => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

export async function isModuleRoot(file: string): Promise<boolean> {
	const dir = path.dirname(file);
	if (path.basename(path.dirname(dir)) !== MODULES_DIR) return false;
	return lstat(path.join(dir, MANIFEST)).then(s => s.isFile(), () => false);
}

export async function loadRules(file: string): Promise<Entry> {
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return {key: 'none', loaded: {kind: 'none'}};
		return {key: 'unreadable', loaded: {kind: 'bad', problem: 'the file cannot be read'}};
	}
	const dataAllowed = await isModuleRoot(file);
	const key = `${statKey(info)}:${dataAllowed ? 1 : 0}`;
	const hit = parsed.get(file);
	if (hit?.key === key) return hit;
	const entry = await readRules(file, info, key, dataAllowed);
	if (parsed.size >= PARSED_MAX) parsed.clear();
	parsed.set(file, entry);
	return entry;
}

async function readRules(file: string, info: Stats, key: string, dataAllowed: boolean): Promise<Entry> {
	const bad = (problem: string): Entry => ({key, loaded: {kind: 'bad', problem}});
	if (!info.isFile()) return bad('not a regular file (a symlink, folder or special file)');
	if (info.size > RULES_MAX_BYTES) return bad(`larger than ${RULES_MAX_BYTES} bytes`);
	let text: string;
	try {
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			text = new TextDecoder('utf-8', {fatal: true}).decode(await handle.readFile());
		} finally {
			await handle.close();
		}
	} catch (error) {
		return bad(error instanceof TypeError ? 'not valid UTF-8' : 'the file cannot be read');
	}
	const result = parseRules(text, {dataAllowed});
	return result.ok
		? {key, loaded: {kind: 'ok', sections: result.sections, data: result.data, declared: result.declared}}
		: {key, loaded: {kind: 'bad', problem: result.problem, ...(result.line !== undefined && {line: result.line})}};
}

export type RulesScope = {
	roots: string[];
	projects?: () => Promise<ProjectAccess | undefined>;
	rulesFile?: (name: string) => string | undefined;
	modules?: () => Promise<ModuleDirs[]>;
	index?: RulesIndexReader;
};

const within = (child: string, dir: string): boolean => child === dir || child.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

const realOf = (p: string): Promise<string> => realpath(p).catch(() => path.resolve(p));

export type Base = {dir: string; projectFile?: string; dataRules?: string};

async function dirNames(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir, {withFileTypes: true})).filter(e => e.isDirectory()).map(e => e.name);
	} catch {
		return [];
	}
}

async function stageProject(base: string, access: ProjectAccess | undefined, workplace: string): Promise<string | undefined> {
	for (const s of access?.stages ?? []) if ((await realOf(s.path)) === base) return s.project;
	const name = path.basename(base);
	const known = (await dirNames(workplace)).filter(n => name.startsWith(`${n}-stage-`));
	return known.sort((a, b) => b.length - a.length)[0];
}

async function projectNameOf(dir: string, access: ProjectAccess | undefined, wp: string | undefined, st: string | undefined): Promise<string | undefined> {
	if (wp !== undefined && path.dirname(dir) === wp) return path.basename(dir);
	if (wp !== undefined && st !== undefined && path.dirname(dir) === st) return stageProject(dir, access, wp);
	return undefined;
}

async function makeBase(dir: string, scope: RulesScope, access: ProjectAccess | undefined, wp: string | undefined, st: string | undefined): Promise<Base> {
	const name = await projectNameOf(dir, access, wp, st);
	const projectFile = name === undefined ? undefined : scope.rulesFile?.(name);
	return {dir, ...(projectFile !== undefined && {projectFile})};
}

async function roots(scope: RulesScope): Promise<{access?: ProjectAccess; projectDir?: string; wp?: string; st?: string}> {
	const access = await scope.projects?.();
	const [workplace, stage] = access?.roots ?? [];
	const projectDir = scope.roots[0] === undefined ? undefined : await realOf(scope.roots[0]);
	return {
		...(access && {access}),
		...(projectDir !== undefined && {projectDir}),
		...(workplace !== undefined && {wp: await realOf(workplace)}),
		...(stage !== undefined && {st: await realOf(stage)}),
	};
}

async function moduleList(scope: RulesScope): Promise<ModuleDirs[]> {
	try {
		return (await scope.modules?.()) ?? [];
	} catch {
		return [];
	}
}

async function baseFor(real: string, scope: RulesScope): Promise<Base | undefined> {
	const {access, projectDir, wp, st} = await roots(scope);
	const found: string[] = [];
	if (projectDir !== undefined && within(real, projectDir)) found.push(projectDir);
	for (const top of [wp, st]) {
		if (top === undefined || real === top || !within(real, top)) continue;
		found.push(path.join(top, path.relative(top, real).split(path.sep)[0] as string));
	}
	if (found.length === 0) {
		for (const m of await moduleList(scope)) {
			const code = await realOf(m.codeDir);
			if (within(real, code)) found.push(code);
		}
	}
	const dir = found.sort((a, b) => b.length - a.length)[0];
	return dir === undefined ? undefined : makeBase(dir, scope, access, wp, st);
}

async function allBases(scope: RulesScope): Promise<Base[]> {
	const {access, projectDir, wp, st} = await roots(scope);
	const dirs = new Set<string>(projectDir === undefined ? [] : [projectDir]);
	for (const top of [wp, st]) if (top !== undefined) for (const n of await dirNames(top)) dirs.add(path.join(top, n));
	const out = await Promise.all([...dirs].map(d => makeBase(d, scope, access, wp, st)));
	const taken = [...dirs];
	const dataBases: Base[] = [];
	for (const m of await moduleList(scope)) {
		const code = await realOf(m.codeDir);
		if (!taken.some(d => within(code, d))) {
			taken.push(code);
			out.push({dir: code});
		}
		const rootFile = path.join(code, RULES_FILE);
		const {loaded} = await loadRules(rootFile);
		const hasData = loaded.kind === 'ok' && SECTIONS.some(s => loaded.data[s].length > 0);
		if (loaded.kind === 'bad' || hasData) dataBases.push({dir: await realOf(m.dataDir), dataRules: rootFile});
	}
	return [...out, ...dataBases];
}

export type RulesVerdict = {
	read: Level;
	write: Level;
	section?: Section;
	label?: string;
	kind?: 'rules' | 'malformed' | 'rules-file';
	malformed?: Problem;
};

const FREE: RulesVerdict = {read: 'free', write: 'free'};

const projectLabel = (file: string): string => `the project's rules (${path.basename(file, RULES_FILE)})`;

async function rulesDirs(scope: RulesScope): Promise<string[]> {
	const sample = scope.rulesFile?.('a');
	if (sample === undefined) return [];
	const dir = path.dirname(sample);
	return [dir, await realOf(dir)];
}

type Found = {section: Section; label: string; kind: 'rules' | 'malformed'; malformed?: Problem};

const malformedFound = (label: string, loaded: {problem: string; line?: number}): Found => ({
	section: 'deny read',
	label,
	kind: 'malformed',
	malformed: {file: label, problem: loaded.problem, ...(loaded.line !== undefined && {line: loaded.line})},
});

// The module's own root file judges the module's data folder through its "@" lines.
async function dataFound(real: string, scope: RulesScope, isDirHint: boolean | undefined): Promise<Found[]> {
	const out: Found[] = [];
	for (const m of await moduleList(scope)) {
		const bases = [path.resolve(m.dataDir), await realOf(m.dataDir)];
		const dir = bases.find(b => within(real, b));
		if (dir === undefined) continue;
		const file = path.join(path.resolve(m.codeDir), RULES_FILE);
		const {loaded} = await loadRules(file);
		if (loaded.kind === 'none') continue;
		if (loaded.kind === 'bad') {
			out.push(malformedFound(file, loaded));
			continue;
		}
		const rel = path.relative(dir, real);
		if (rel === '') continue;
		const isDir = isDirHint ?? (await stat(real).then(s => s.isDirectory(), () => false));
		const segs = rel.split(path.sep);
		for (const section of SECTIONS) if (decide(loaded.data[section], segs, isDir)) out.push({section, label: file, kind: 'rules'});
	}
	return out;
}

export async function rulesVerdict(real: string, scope: RulesScope, isDirHint?: boolean): Promise<RulesVerdict> {
	const base = await baseFor(real, scope);
	const found: Found[] = [];
	let isDir = isDirHint;
	if (base !== undefined && real !== base.dir) {
		isDir ??= await stat(real).then(s => s.isDirectory(), () => false);
		const chain: Array<{folder: string; file: string; label: string}> = [];
		const rel = path.relative(base.dir, path.dirname(real));
		let folder = base.dir;
		chain.push({folder, file: path.join(folder, RULES_FILE), label: path.join(folder, RULES_FILE)});
		for (const seg of rel === '' ? [] : rel.split(path.sep)) {
			folder = path.join(folder, seg);
			chain.push({folder, file: path.join(folder, RULES_FILE), label: path.join(folder, RULES_FILE)});
		}
		if (base.projectFile !== undefined) chain.push({folder: base.dir, file: base.projectFile, label: projectLabel(base.projectFile)});
		for (const src of chain) {
			const {loaded} = await loadRules(src.file);
			if (loaded.kind === 'none') continue;
			if (loaded.kind === 'bad') {
				if (real === src.file) continue;
				found.push(malformedFound(src.label, loaded));
				continue;
			}
			const segs = path.relative(src.folder, real).split(path.sep);
			for (const section of SECTIONS) {
				if (decide(loaded.sections[section], segs, isDir)) found.push({section, label: src.label, kind: 'rules'});
			}
		}
	}
	if (scope.modules) found.push(...(await dataFound(real, scope, isDir)));
	const pick = (s: Section) => found.find(f => f.section === s);
	const denyRead = pick('deny read');
	const denyWrite = pick('deny write');
	const askRead = pick('ask read');
	const askWrite = pick('ask write');
	const decider = denyRead ?? denyWrite ?? askRead ?? askWrite;
	const verdict: RulesVerdict = {
		read: denyRead ? 'deny' : askRead ? 'ask' : 'free',
		write: denyRead || denyWrite ? 'deny' : askWrite ? 'ask' : 'free',
		...(decider && {section: decider.section, label: decider.label, kind: decider.kind}),
		...(denyRead?.malformed && {malformed: denyRead.malformed}),
	};
	if (verdict.write !== 'deny') {
		const builtIn =
			path.basename(real) === RULES_FILE || (await rulesDirs(scope)).some(d => within(real, d));
		if (builtIn) return {...verdict, write: 'deny', section: 'deny write', label: RULES_FILE, kind: 'rules-file'};
	}
	return decider === undefined && verdict.write === 'free' ? FREE : verdict;
}

const exportHit = (sections: Sections, segs: string[], isDir: boolean): boolean =>
	decide(sections['deny export'], segs, isDir) || decide(sections['deny read'], segs, isDir);

// True when the module's rules close this path of its data folder or its code folder to export.
export async function exportVerdict(real: string, target: ModuleDirs, isDirHint?: boolean): Promise<boolean> {
	const data = path.resolve(target.dataDir);
	const code = path.resolve(target.codeDir);
	const isData = within(real, data);
	if (!isData && !within(real, code)) return false;
	const dir = isData ? data : code;
	const isDir = isDirHint ?? (await stat(real).then(s => s.isDirectory(), () => false));
	if (isData) {
		const {loaded} = await loadRules(path.join(code, RULES_FILE));
		if (loaded.kind === 'none') return false;
		if (loaded.kind === 'bad') return true;
		const rel = path.relative(dir, real);
		return rel === '' ? false : exportHit(loaded.data, rel.split(path.sep), isDir);
	}
	if (real === code) return false;
	const rel = path.relative(code, path.dirname(real));
	let folder = code;
	for (const seg of rel === '' ? [''] : ['', ...rel.split(path.sep)]) {
		folder = path.join(folder, seg);
		const {loaded} = await loadRules(path.join(folder, RULES_FILE));
		if (loaded.kind === 'none') continue;
		if (loaded.kind === 'bad') return true;
		if (exportHit(loaded.sections, path.relative(folder, real).split(path.sep), isDir)) return true;
	}
	return false;
}

export type Expansion = {
	denyRead: string[];
	askRead: string[];
	denyWrite: string[];
	askWrite: string[];
	denyExport: string[];
	rulesFiles: string[];
	problems: Problem[];
	truncated: boolean;
};

type Src = {folder: string; file: string; label: string; sections: Sections};
type State = {src: Src; segs: string[]; last: number[]};
type Acc = {count: number; max: number; truncated: boolean; problems: Problem[]; rulesFiles: string[]; keys: Map<string, string>};
type Result = {paths: string[][]; full: boolean[]; closed?: true};

const blankStates = (): number[] => new Array<number>(COUNT).fill(-1);
const blankPaths = (): string[][] => Array.from({length: COUNT}, () => []);
const allFull = (v: boolean): boolean[] => new Array<boolean>(COUNT).fill(v);
const range = Array.from({length: COUNT}, (_, i) => i);

const hasLaterNeg = (lines: Line[], last: number, segs: string[]): boolean =>
	lines.some((l, i) => {
		if (!l.neg || i <= last) return false;
		if (!l.anchored) return true;
		for (let k = 0; k < Math.min(l.prefix.length, segs.length); k++) if (l.prefix[k] !== segs[k]) return false;
		return true;
	});

async function enter(dir: string, states: State[], shallow: boolean, acc: Acc): Promise<{states: State[]; closed: boolean}> {
	if (shallow) return {states, closed: false};
	const file = path.join(dir, RULES_FILE);
	const {key, loaded} = await loadRules(file);
	if (loaded.kind === 'none') return {states, closed: false};
	acc.keys.set(file, key);
	acc.rulesFiles.push(file);
	if (loaded.kind === 'bad') {
		acc.problems.push({file, problem: loaded.problem, ...(loaded.line !== undefined && {line: loaded.line})});
		return {states, closed: true};
	}
	const src: Src = {folder: dir, file, label: file, sections: loaded.sections};
	return {states: [...states, {src, segs: [], last: blankStates()}], closed: false};
}

// A data walk (data = true) follows only the lines it was given and never reads nested rules files.
async function visit(dir: string, parent: State[], shallow: boolean, acc: Acc, data: boolean): Promise<Result> {
	const {states, closed} = data ? {states: parent, closed: false} : await enter(dir, parent, shallow, acc);
	if (closed) {
		const paths = blankPaths();
		paths[DENY_READ] = [dir];
		return {paths, full: range.map(s => s === DENY_READ), closed: true};
	}
	let names: Array<{name: string; dir: boolean}> = [];
	try {
		names = (await readdir(dir, {withFileTypes: true})).map(e => ({name: e.name, dir: e.isDirectory()}));
	} catch {
		return {paths: blankPaths(), full: allFull(true)};
	}
	const out: Result = {paths: blankPaths(), full: allFull(true)};
	for (const {name, dir: isDir} of names) {
		if (name === SKIPPED_DIR && !data) continue;
		if (acc.count >= acc.max) {
			acc.truncated = true;
			out.full = allFull(false);
			break;
		}
		acc.count++;
		const entry = path.join(dir, name);
		const next: State[] = states.map(st => {
			const segs = [...st.segs, name];
			const last = st.last.slice();
			SECTIONS.forEach((section, s) => {
				st.src.sections[section].forEach((line, i) => {
					if (lineMatchesEntry(line, segs, isDir)) last[s] = i;
				});
			});
			return {src: st.src, segs, last};
		});
		const inS = range.map(s =>
			next.some(st => {
				const lines = st.src.sections[SECTIONS[s] as Section];
				const l = lines[st.last[s] as number];
				return l !== undefined && !l.neg;
			}),
		);
		const opaque = !data && name === OPAQUE_DIR && states.every(st => st.segs.length === 0);
		const whole = range.map(s => {
			if (!inS[s]) return false;
			if (opaque) return true;
			return !next.some(st => {
				const lines = st.src.sections[SECTIONS[s] as Section];
				const l = lines[st.last[s] as number];
				return l !== undefined && !l.neg && hasLaterNeg(lines, st.last[s] as number, st.segs);
			});
		});
		if (!isDir) {
			for (const s of range) {
				if (inS[s]) out.paths[s]!.push(entry);
				else out.full[s] = false;
			}
			continue;
		}
		let sub: Result | undefined;
		if (!opaque && !shallow && whole.some(w => !w)) sub = await visit(entry, next, !data && name === '.git', acc, data);
		for (const s of range) {
			if (whole[s]) out.paths[s]!.push(entry);
			else if (sub === undefined) {
				if (inS[s]) out.paths[s]!.push(entry);
				else out.full[s] = false;
			} else if (inS[s] && sub.full[s]) out.paths[s]!.push(entry);
			else {
				out.paths[s]!.push(...sub.paths[s]!);
				out.full[s] = false;
			}
		}
	}
	return out;
}

export type ExpandOptions = {maxEntries?: number};

export type Detailed = {value: Expansion; keys: Array<[string, string]>; bases: Base[]};

export async function expandBases(bases: Base[], opts: ExpandOptions = {}): Promise<Detailed> {
	const acc: Acc = {count: 0, max: opts.maxEntries ?? EXPAND_MAX_ENTRIES, truncated: false, problems: [], rulesFiles: [], keys: new Map()};
	const lists = blankPaths();
	for (const base of bases) {
		const states: State[] = [];
		if (base.dataRules !== undefined) {
			const {key, loaded} = await loadRules(base.dataRules);
			acc.keys.set(base.dataRules, key);
			if (loaded.kind === 'bad') lists[DENY_READ]!.push(base.dir);
			if (loaded.kind !== 'ok') continue;
			const src: Src = {folder: base.dir, file: base.dataRules, label: base.dataRules, sections: loaded.data};
			const result = await visit(base.dir, [{src, segs: [], last: blankStates()}], false, acc, true);
			for (const s of range) lists[s]!.push(...result.paths[s]!);
			continue;
		}
		if (base.projectFile !== undefined) {
			const {key, loaded} = await loadRules(base.projectFile);
			acc.keys.set(base.projectFile, key);
			if (loaded.kind === 'bad') {
				acc.problems.push({file: projectLabel(base.projectFile), problem: loaded.problem, ...(loaded.line !== undefined && {line: loaded.line})});
				lists[DENY_READ]!.push(base.dir);
				continue;
			}
			if (loaded.kind === 'ok') {
				states.push({src: {folder: base.dir, file: base.projectFile, label: projectLabel(base.projectFile), sections: loaded.sections}, segs: [], last: blankStates()});
			}
		}
		const result = await visit(base.dir, states, false, acc, false);
		for (const s of range) lists[s]!.push(...result.paths[s]!);
	}
	const unique = (list: string[]): string[] => [...new Set(list)];
	const value: Expansion = {
		denyRead: unique(lists[DENY_READ]!),
		askRead: unique(lists[1]!),
		denyWrite: unique(lists[2]!),
		askWrite: unique(lists[3]!),
		denyExport: unique([...lists[DENY_EXPORT]!, ...lists[DENY_READ]!]),
		rulesFiles: unique(acc.rulesFiles),
		problems: acc.problems,
		truncated: acc.truncated,
	};
	return {value, keys: [...acc.keys], bases};
}

export async function expandDetailed(scope: RulesScope, opts: ExpandOptions = {}): Promise<Detailed> {
	return expandBases(await allBases(scope), opts);
}

export async function expandRules(scope: RulesScope, opts: ExpandOptions = {}): Promise<Expansion> {
	return (await expandDetailed(scope, opts)).value;
}

export const entriesInside = (list: string[], dir: string): string[] => list.filter(p => within(p, dir));

export function resetParseCache(): void {
	parsed.clear();
}
