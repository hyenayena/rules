import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after} from 'node:test';
import type {Logger} from '../../../src/api.js';

export function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `rules-${prefix}-`)));
	after(() => rmSync(dir, {recursive: true, force: true}));
	return dir;
}

export const put = (file: string, text = 'x'): string => {
	mkdirSync(path.dirname(file), {recursive: true});
	writeFileSync(file, text);
	return file;
};

export const quietLog: Logger = {
	error() {},
	warn() {},
	info() {},
	debug() {},
	child() {
		return quietLog;
	},
	addRedactor() {},
};

// A yena checkout with modules: <root>/modules/<name>/yena.json and data in <root>/data/<name>
export function makeModules(root: string, names: string[]) {
	return names.map(name => {
		const codeDir = path.join(root, 'modules', name);
		put(path.join(codeDir, 'yena.json'), '{}');
		const dataDir = path.join(root, 'data', name);
		mkdirSync(dataDir, {recursive: true});
		return {name, codeDir, dataDir};
	});
}
