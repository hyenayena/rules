import assert from 'node:assert/strict';
import {chmodSync, lstatSync, readFileSync, symlinkSync} from 'node:fs';
import path from 'node:path';
import {beforeEach, describe, it} from 'node:test';
import type {ModuleDirs} from '../../../src/api.js';
import {resetParseCache} from '../src/engine.js';
import {migrateLegacyExports} from '../src/migrate.js';
import {makeModules, put, quietLog, tempDir} from './helpers.js';

beforeEach(() => resetParseCache());

const layoutOf = (modules: ModuleDirs[]) => ({modules});

describe('automatic export migration', () => {
	it('writes the header and one @ line per legacy pattern, creating the file', async () => {
		const root = tempDir('m1');
		const [m] = makeModules(root, ['m']) as [ModuleDirs];
		const r = await migrateLegacyExports(layoutOf([{...m, legacyExport: {deny: ['state.json', 'cache/**', '*.tmp']}}]), quietLog);
		assert.equal(r.migrated, 1);
		const file = path.join(m.codeDir, '.yenarules');
		assert.match(readFileSync(file, 'utf8'), /\[deny export\]\n@state\.json\n@cache\/\*\*\n@\*\.tmp\n$/);
		assert.equal(lstatSync(file).mode & 0o777, 0o644);
	});

	it('an empty list gives just the header, an existing file is kept and appended to', async () => {
		const root = tempDir('m2');
		const [a, b] = makeModules(root, ['a', 'b']) as [ModuleDirs, ModuleDirs];
		const fileB = put(path.join(b.codeDir, '.yenarules'), '[ask write]\n/src/x.ts\n');
		chmodSync(fileB, 0o600);
		await migrateLegacyExports(layoutOf([{...a, legacyExport: {deny: []}}, {...b, legacyExport: {deny: ['x']}}]), quietLog);
		assert.match(readFileSync(path.join(a.codeDir, '.yenarules'), 'utf8'), /\n\[deny export\]\n$/);
		assert.equal(readFileSync(fileB, 'utf8'), '[ask write]\n/src/x.ts\n\n[deny export]\n@x\n');
		assert.equal(lstatSync(fileB).mode & 0o777, 0o600);
	});

	it('does nothing for a module that has a header already, no legacy list, a malformed file or a symlink', async () => {
		const root = tempDir('m3');
		const [done, none, bad, link] = makeModules(root, ['done', 'none', 'bad', 'link']) as [ModuleDirs, ModuleDirs, ModuleDirs, ModuleDirs];
		const fileDone = put(path.join(done.codeDir, '.yenarules'), '[deny export]\n');
		const fileBad = put(path.join(bad.codeDir, '.yenarules'), '[nope]\n');
		const real = put(path.join(root, 'real'), '');
		symlinkSync(real, path.join(link.codeDir, '.yenarules'));
		const r = await migrateLegacyExports(layoutOf([{...done, legacyExport: {deny: ['a']}}, none, {...bad, legacyExport: {deny: ['a']}}, {...link, legacyExport: {deny: ['a']}}]), quietLog);
		assert.equal(r.migrated, 0);
		assert.equal(readFileSync(fileDone, 'utf8'), '[deny export]\n');
		assert.equal(readFileSync(fileBad, 'utf8'), '[nope]\n');
		assert.equal(readFileSync(real, 'utf8'), '');
	});

	it('skips a read-only code folder silently', async () => {
		const root = tempDir('m4');
		const [m] = makeModules(root, ['m']) as [ModuleDirs];
		chmodSync(m.codeDir, 0o500);
		const r = await migrateLegacyExports(layoutOf([{...m, legacyExport: {deny: ['a']}}]), quietLog);
		chmodSync(m.codeDir, 0o700);
		if (process.getuid?.() !== 0) assert.equal(r.unwritable, 1);
	});
});
