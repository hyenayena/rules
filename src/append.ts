import {constants} from 'node:fs';
import {lstat, open, realpath} from 'node:fs/promises';
import path from 'node:path';
import {commandError} from './deps/core.js';
import type {ProjectReader} from './deps/project.js';
import {lockedRulesWrite, writeRulesAtomic} from './atomic.js';
import {isModuleRoot, parseRules, RULES_FILE, RULES_MAX_BYTES, RULES_MAX_LINES, SECTIONS, type Section, statKey} from './engine.js';

export const MAX_PATTERNS = 32;
export const MAX_PATTERN_LENGTH = 200;
export const NEW_FILE_MODE = 0o644;
export const NEW_FILE_HEADER = '# Rules for the assistant in this repository (format: /data/md/architecture/claude/rules-files.md). Only the user edits this file.';

const HEADER_LIKE = /^\[[^\]]*\]$/;

export type AppendTarget = {file: string} | {project: string};
export type AppendRequest = {target: AppendTarget; section: string; patterns: string[]};
export type AppendResult = {file: string; created: boolean; lines: number; section: Section; kind: 'repo' | 'project'};
export type AppendDeps = {projects?: ProjectReader | undefined};

const hasControl = (text: string): boolean => {
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
	}
	return false;
};

export function checkPattern(pattern: string): void {
	const shown = JSON.stringify(pattern.slice(0, 40));
	if (pattern === '' || pattern.length > MAX_PATTERN_LENGTH) throw commandError('invalid', `A pattern must be 1 to ${MAX_PATTERN_LENGTH} characters`);
	if (hasControl(pattern)) throw commandError('invalid', `Pattern ${shown} has a control character`);
	if (pattern.startsWith('!')) throw commandError('invalid', `Pattern ${shown} starts with "!": rules add only closes more, so it cannot re-open paths`);
	if (pattern.startsWith('#')) throw commandError('invalid', `Pattern ${shown} starts with "#": use \\# for a name that starts with "#"`);
	if (HEADER_LIKE.test(pattern)) throw commandError('invalid', `Pattern ${shown} would be read as a section header`);
	if (/\s$/.test(pattern)) throw commandError('invalid', `Pattern ${shown} ends with a space, which the file format drops`);
}

export function parseSection(raw: string): Section {
	const name = raw.replace(/-/g, ' ');
	if (!(SECTIONS as readonly string[]).includes(name)) throw commandError('invalid', `Unknown section "${raw.slice(0, 40)}". Sections: ${SECTIONS.join(', ')}`);
	return name as Section;
}

const within = (child: string, dir: string): boolean => child === dir || child.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

async function realFolder(dir: string): Promise<string> {
	let info;
	try {
		info = await lstat(dir);
	} catch {
		throw commandError('not-found', 'The folder does not exist');
	}
	if (!info.isDirectory()) throw commandError('invalid', 'The folder is not a real folder (a symlink or a file)');
	const real = await realpath(dir);
	if (real !== dir) throw commandError('invalid', 'The path goes through a symlink; use the real path');
	return real;
}

async function checkIsolated(dir: string, projects: ProjectReader | undefined): Promise<void> {
	const access = await projects?.read();
	const [workplace, stage] = access?.roots ?? [];
	const top = [workplace, stage].find(t => t !== undefined && dir !== t && within(dir, t));
	if (access === undefined || top === undefined) {
		throw commandError('invalid', 'Only a .yenarules inside a project in /workplace or a stage can be changed here; edit any other file by hand');
	}
	const child = path.join(top, path.relative(top, dir).split(path.sep)[0] as string);
	const project = access.stages?.find(s => s.path === child)?.project ?? path.basename(child).replace(/-stage-.*$/, '');
	const writable = await Promise.all(access.writable.map(w => realpath(w).catch(() => w)));
	if (!writable.some(w => within(dir, w))) {
		throw commandError('not-isolated', `"${project}" is read-only; run "project isolate ${project}" first`);
	}
}

export type Existing = {text: string; key: string; mode: number};

export async function readExisting(file: string): Promise<Existing | undefined> {
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw commandError('invalid', 'The rules file cannot be read');
	}
	if (!info.isFile()) throw commandError('invalid', 'The rules file is not a regular file (a symlink, folder or special file)');
	if (info.size > RULES_MAX_BYTES) throw commandError('invalid', `The rules file is larger than ${RULES_MAX_BYTES} bytes`);
	try {
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const text = new TextDecoder('utf-8', {fatal: true}).decode(await handle.readFile());
			return {text, key: statKey(info), mode: info.mode & 0o777};
		} finally {
			await handle.close();
		}
	} catch {
		throw commandError('invalid', 'The rules file cannot be read as UTF-8 text');
	}
}

export function composeAppend(text: string, section: Section, patterns: readonly string[]): string {
	const lines = text.split('\n');
	let last: string | undefined;
	for (const l of lines) {
		const t = l.replace(/[ \r]+$/, '');
		if (HEADER_LIKE.test(t)) last = t.slice(1, -1);
	}
	let out = text === '' || text.endsWith('\n') ? text : `${text}\n`;
	if (last !== section) out += `${out === '' || out.endsWith('\n\n') ? '' : '\n'}[${section}]\n`;
	return out + patterns.map(p => `${p}\n`).join('');
}

export async function appendRules(req: AppendRequest, deps: AppendDeps): Promise<AppendResult> {
	const section = parseSection(req.section);
	if (req.patterns.length === 0) throw commandError('usage', 'Give at least one pattern');
	if (req.patterns.length > MAX_PATTERNS) throw commandError('invalid', `At most ${MAX_PATTERNS} patterns at once`);
	for (const p of req.patterns) checkPattern(p);
	let file: string;
	let kind: 'repo' | 'project';
	if ('project' in req.target) {
		const found = deps.projects?.rulesFile?.(req.target.project);
		if (found === undefined) throw commandError('invalid', `"${req.target.project.slice(0, 64)}" is not a project name`);
		file = found;
		kind = 'project';
	} else {
		const given = path.resolve(req.target.file);
		file = path.basename(given) === RULES_FILE ? given : path.join(given, RULES_FILE);
		kind = 'repo';
		const dir = await realFolder(path.dirname(file));
		await checkIsolated(dir, deps.projects);
	}
	return lockedRulesWrite(file, async () => {
		const existing = await readExisting(file);
		if (existing === undefined && kind === 'project') {
			const name = 'project' in req.target ? req.target.project : '';
			throw commandError('not-found', `"${name.slice(0, 64)}" has no rules file yet; run "project isolate ${name.slice(0, 64)}" first`);
		}
		const dataAllowed = await isModuleRoot(file);
		const before = existing === undefined ? undefined : parseRules(existing.text, {dataAllowed});
		if (before !== undefined && !before.ok) {
			throw commandError('invalid', `The rules file is malformed (line ${before.line ?? 0}: ${before.problem}); fix it by hand first`);
		}
		if (section === 'deny export' && dataAllowed && !(before?.ok && before.declared.has('deny export'))) {
			throw commandError('invalid', 'This module root has no [deny export] list yet: adding it would allow exporting its data, so write it by hand');
		}
		const base = existing?.text ?? (kind === 'repo' ? `${NEW_FILE_HEADER}\n` : '');
		const text = composeAppend(base, section, req.patterns);
		if (Buffer.byteLength(text) > RULES_MAX_BYTES || text.split('\n').length > RULES_MAX_LINES + 1) {
			throw commandError('invalid', 'The rules file would become too large');
		}
		const after = parseRules(text, {dataAllowed});
		if (!after.ok) throw commandError('invalid', `The result would be malformed (line ${after.line ?? 0}: ${after.problem})`);
		try {
			await writeRulesAtomic(file, text, existing?.mode ?? NEW_FILE_MODE, existing?.key);
		} catch (error) {
			throw commandError('invalid', error instanceof Error ? error.message : 'The rules file could not be written');
		}
		return {file, created: existing === undefined, lines: req.patterns.length, section, kind};
	});
}
