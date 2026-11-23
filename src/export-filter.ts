import path from 'node:path';
import type {ExportFilter, ModuleDirs, ModuleExportRules, RulesProvider} from '../../../src/api.js';
import {exportVerdict, loadRules, RULES_FILE} from './engine.js';
import type {RulesIndexReader} from './index-store.js';

const regexCache = new Map<string, RegExp>();

function segmentRegExp(segment: string): RegExp {
	let re = regexCache.get(segment);
	if (!re) {
		let source = '';
		for (const ch of segment) {
			if (ch === '*') source += '[^/]*';
			else if (ch === '?') source += '[^/]';
			else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
		re = new RegExp(`^${source}$`, 's');
		regexCache.set(segment, re);
	}
	return re;
}

function matchSegments(pattern: readonly string[], p: number, parts: readonly string[], i: number): boolean {
	if (p === pattern.length) return i === parts.length;
	const head = pattern[p]!;
	if (head === '**') {
		for (let k = i; k <= parts.length; k++) if (matchSegments(pattern, p + 1, parts, k)) return true;
		return false;
	}
	if (i === parts.length) return false;
	return segmentRegExp(head).test(parts[i]!) && matchSegments(pattern, p + 1, parts, i + 1);
}

// The matcher of the old yena.json export.deny, used until the module's root .yenarules declares [deny export].
export function legacyDenied(rules: ModuleExportRules, rel: string): boolean {
	const parts = rel.split('/');
	for (const pattern of rules.deny) {
		const segments = pattern.split('/');
		for (let end = 1; end <= parts.length; end++) {
			if (matchSegments(segments, 0, parts.slice(0, end), 0)) return true;
		}
	}
	return false;
}

export function createExportProvider(reader: RulesIndexReader): RulesProvider {
	const indexed = (target: ModuleDirs, part: 'data' | 'code') => {
		const dir = path.resolve(part === 'data' ? target.dataDir : target.codeDir);
		let entries: Set<string> | undefined;
		return async (rel: string): Promise<boolean> => {
			if (entries === undefined) {
				entries = new Set();
				try {
					const lists = await reader.get({});
					if (!lists.truncated) {
						for (const p of lists.denyExport) if (p === dir || p.startsWith(dir + path.sep)) entries.add(p);
					}
				} catch {
				}
			}
			if (entries.size === 0) return false;
			let cur = dir;
			for (const seg of rel.split('/')) {
				cur = path.join(cur, seg);
				if (entries.has(cur)) return true;
			}
			return false;
		};
	};
	const combined = (target: ModuleDirs, part: 'data' | 'code', note?: string): ExportFilter => {
		const hit = indexed(target, part);
		const base = path.resolve(part === 'data' ? target.dataDir : target.codeDir);
		return {
			denied: async (rel, isDir) => (await hit(rel)) || exportVerdict(path.join(base, ...rel.split('/')), target, isDir),
			...(note !== undefined && {note}),
		};
	};
	return {
		async exportFilter(target, part) {
			const {loaded} = await loadRules(path.join(target.codeDir, RULES_FILE));
			if (loaded.kind === 'bad' && part === 'data') {
				const where = loaded.line === undefined ? '' : ` (line ${loaded.line}: ${loaded.problem})`;
				return {denied: async () => true, note: `its .yenarules is malformed${where || ` (${loaded.problem})`}, so none of its data was exported`};
			}
			if (part === 'code') return combined(target, 'code');
			if (loaded.kind === 'ok' && loaded.declared.has('deny export')) return combined(target, 'data');
			if (target.legacyExport !== undefined) {
				const rules = target.legacyExport;
				// deny read implies deny export here too, even before the header exists
				const base = path.resolve(target.dataDir);
				return {denied: async (rel, isDir) => legacyDenied(rules, rel) || exportVerdict(path.join(base, ...rel.split('/')), target, isDir)};
			}
			return undefined;
		},
	};
}
