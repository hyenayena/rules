import assert from 'node:assert/strict';
import path from 'node:path';
import {beforeEach, describe, it} from 'node:test';
import type {ModuleDirs, ModuleExportRules} from '../../../src/api.js';
import {resetParseCache} from '../src/engine.js';
import {createExportProvider, legacyDenied} from '../src/export-filter.js';
import {legacyLine} from '../src/migrate.js';
import {rulesIndex} from '../src/index-store.js';
import {makeModules, put, tempDir} from './helpers.js';

beforeEach(() => resetParseCache());

const reader = (root: string) => rulesIndex(path.join(root, 'data', 'rules-test'), {root});

describe('legacy export patterns', () => {
	const d = (deny: string[], rel: string) => legacyDenied({deny}, rel);

	it('"*" stops at "/" and matches dotfiles', () => {
		assert.equal(d(['*.log', 'cache/*'], 'a.log'), true);
		assert.equal(d(['*.log', 'cache/*'], '.hidden.log'), true);
		assert.equal(d(['*.log', 'cache/*'], 'sub/a.log'), false);
		assert.equal(d(['*.log', 'cache/*'], 'cache/.x'), true);
		assert.equal(d(['*.log', 'cache/*'], 'other/cache/x'), false);
	});

	it('"**" matches zero or more segments', () => {
		assert.equal(d(['**'], '.a/b/.c'), true);
		assert.equal(d(['a/**/z'], 'a/z'), true);
		assert.equal(d(['a/**/z'], 'a/b/c'), false);
		assert.equal(d(['dir/**'], 'dir'), true);
		assert.equal(d(['**/secret.txt'], 'x/.y/secret.txt'), true);
		assert.equal(d(['cache'], 'cache/deep/file'), true);
		assert.equal(d(['cache'], 'cachex'), false);
		assert.equal(d([], 'a.json'), false);
	});
});

// every legacy case must give the same answer through an "@" line of a module root file
describe('migrated "@" lines behave like the old patterns', () => {
	const cases: Array<[string[], string[]]> = [
		[['*.log', 'cache/*', 'state.json'], ['a.log', '.hidden.log', 'sub/a.log', 'cache/x', 'cache/.x', 'other/cache/x', 'state.json', 'state.jsonx', 'x/state.json']],
		[['**'], ['a', '.a/b/.c']],
		[['a/**/z', 'dir/**', '**/secret.txt'], ['a/z', 'a/b/c/z', 'a/b/c', 'dir', 'dir/a/b', 'dirx', 'secret.txt', 'x/.y/secret.txt']],
		[['cache'], ['cache', 'cache/deep/file', 'cachex']],
		[['a?c', 'a+b(1).txt', 'a.b', 'f[1].json', 'g**h', '#x', '!y', '@z'], ['abc', 'ac', 'abbc', 'a+b(1).txt', 'axb', 'a.b', 'f[1].json', 'f1.json', 'gh', 'gxxh', 'g/h', '#x', '!y', '@z']],
		[[], ['a.json']],
	];
	for (const [deny, rels] of cases) {
		it(`same exclusions for ${JSON.stringify(deny)}`, async () => {
			const root = tempDir('mig');
			const [m] = makeModules(root, ['m']) as [ModuleDirs];
			const lines = deny.map(p => legacyLine(p) as string);
			put(path.join(m.codeDir, '.yenarules'), `[deny export]\n${lines.join('\n')}\n`);
			const filter = await createExportProvider(reader(root)).exportFilter({...m, legacyExport: {deny}}, 'data');
			assert.ok(filter);
			for (const rel of rels) {
				assert.equal(await filter.denied(rel, false), legacyDenied({deny}, rel), `${rel} with ${JSON.stringify(deny)}`);
			}
		});
	}

	it('refuses patterns it cannot restate exactly', () => {
		assert.equal(legacyLine('a '), undefined);
		assert.equal(legacyLine('a\\b'), undefined);
	});
});

describe('exportFilter', () => {
	const rules: ModuleExportRules = {deny: ['state.json']};

	it('uses the legacy list until the root file has a [deny export] header', async () => {
		const root = tempDir('fallback');
		const [m] = makeModules(root, ['m']) as [ModuleDirs];
		const provider = createExportProvider(reader(root));
		const legacy = await provider.exportFilter({...m, legacyExport: rules}, 'data');
		assert.equal(await legacy?.denied('state.json', false), true);
		assert.equal(await legacy?.denied('other', false), false);
		assert.equal(await provider.exportFilter(m, 'data'), undefined, 'no list at all exports nothing');
	});

	it('a header with no patterns exports everything, @ lines and deny read close paths', async () => {
		const root = tempDir('lists');
		const [m] = makeModules(root, ['m']) as [ModuleDirs];
		const file = path.join(m.codeDir, '.yenarules');
		put(file, '[deny export]\n');
		const provider = createExportProvider(reader(root));
		assert.equal(await (await provider.exportFilter(m, 'data'))?.denied('a/b', false), false);
		put(file, '[deny read]\n@secret/\n[deny export]\n@tmp/**\n');
		const f = await provider.exportFilter(m, 'data');
		assert.equal(await f?.denied('tmp/x', false), true);
		assert.equal(await f?.denied('secret', true), true, 'deny read implies deny export');
		assert.equal(await f?.denied('secret/y', false), true);
		assert.equal(await f?.denied('keep', false), false);
	});

	it('a malformed root file exports nothing and says why', async () => {
		const root = tempDir('bad');
		const [m] = makeModules(root, ['m']) as [ModuleDirs];
		put(path.join(m.codeDir, '.yenarules'), '[deny export]\n@/x\n');
		const f = await createExportProvider(reader(root)).exportFilter({...m, legacyExport: {deny: []}}, 'data');
		assert.equal(await f?.denied('anything', false), true);
		assert.match(f?.note ?? '', /malformed \(line 2: .*\), so none of its data was exported/);
	});

	it('the code filter closes what the module rules close, in nested files too', async () => {
		const root = tempDir('code');
		const [m] = makeModules(root, ['m']) as [ModuleDirs];
		put(path.join(m.codeDir, '.yenarules'), '[deny read]\n.env\n[deny export]\n*.key\n');
		put(path.join(m.codeDir, 'sub', '.yenarules'), '[deny export]\nlocal/\n');
		const f = await createExportProvider(reader(root)).exportFilter(m, 'code');
		assert.ok(f);
		assert.equal(await f.denied('.env', false), true);
		assert.equal(await f.denied('a/b.key', false), true);
		assert.equal(await f.denied('sub/local/x', false), true);
		assert.equal(await f.denied('local/x', false), false);
		assert.equal(await f.denied('src/index.ts', false), false);
	});

	it('a malformed nested rules file closes its folder for the code export', async () => {
		const root = tempDir('codebad');
		const [m] = makeModules(root, ['m']) as [ModuleDirs];
		put(path.join(m.codeDir, 'sub', '.yenarules'), '[nope]\n');
		const f = await createExportProvider(reader(root)).exportFilter(m, 'code');
		assert.equal(await f?.denied('sub/x', false), true);
		assert.equal(await f?.denied('other', false), false);
	});
});
