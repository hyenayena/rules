import {access, constants, lstat} from 'node:fs/promises';
import path from 'node:path';
import type {Logger, RulesLayout} from '../../../src/api.js';
import {composeAppend, NEW_FILE_HEADER, NEW_FILE_MODE, readExisting} from './append.js';
import {writeRulesAtomic} from './atomic.js';
import {isModuleRoot, parseRules, RULES_FILE} from './engine.js';

// The old export.deny pattern as an "@" line that excludes exactly the same paths.
export function legacyLine(pattern: string): string | undefined {
	if (/\s$/.test(pattern) || pattern.includes('\\')) return undefined;
	const segs = pattern.split('/').map(s => (s === '**' ? s : s.replace(/\*+/g, '*').replace(/\[/g, '\\[')));
	return `@${segs.join('/')}`;
}

export type MigrationResult = {migrated: number; skipped: number; unwritable: number};

// The one place a first [deny export] header is added by code instead of by the user: it only restates the module's own
// yena.json list, so the exported files stay exactly the same.
export async function migrateLegacyExports(layout: RulesLayout, log?: Logger): Promise<MigrationResult> {
	const result: MigrationResult = {migrated: 0, skipped: 0, unwritable: 0};
	for (const m of layout.modules) {
		if (m.legacyExport === undefined) continue;
		const code = path.resolve(m.codeDir);
		const file = path.join(code, RULES_FILE);
		try {
			const info = await lstat(code);
			if (!info.isDirectory()) throw new Error('not a folder');
			try {
				await access(code, constants.W_OK);
			} catch {
				result.unwritable++;
				continue;
			}
			if (!(await isModuleRoot(file))) {
				result.skipped++;
				continue;
			}
			const existing = await readExisting(file);
			const dataAllowed = true;
			if (existing !== undefined) {
				const before = parseRules(existing.text, {dataAllowed});
				if (!before.ok || before.declared.has('deny export')) {
					if (!before.ok) result.skipped++;
					continue;
				}
			}
			const lines = m.legacyExport.deny.map(legacyLine);
			if (lines.some(l => l === undefined)) {
				result.skipped++;
				continue;
			}
			const text = composeAppend(existing?.text ?? `${NEW_FILE_HEADER}\n`, 'deny export', lines as string[]);
			const after = parseRules(text, {dataAllowed});
			if (!after.ok || after.data['deny export'].length !== lines.length) {
				result.skipped++;
				continue;
			}
			await writeRulesAtomic(file, text, existing?.mode ?? NEW_FILE_MODE, existing?.key);
			result.migrated++;
		} catch (error) {
			result.skipped++;
			log?.warn('rules export migration failed', {err: error, module: m.name});
		}
	}
	log?.info('rules export migration', {...result});
	return result;
}
