import assert from 'node:assert/strict';
import {readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {beforeEach, describe, it} from 'node:test';
import type {ModuleDirs, RulesLayout} from '../../../src/api.js';
import {appendRules} from '../src/append.js';
import type {ProjectAccess, ProjectReader} from '../src/deps/project.js';
import {resetParseCache, rulesVerdict, type RulesScope} from '../src/engine.js';
import {createExportProvider} from '../src/export-filter.js';
import {parseStored, resetIndexMemo, rulesDataDirFor, rulesIndex, type RulesIndexReader} from '../src/index-store.js';
import {migrateLegacyExports} from '../src/migrate.js';
import {makeModules, put, quietLog, tempDir} from './helpers.js';

beforeEach(() => {
	resetParseCache();
	resetIndexMemo();
});

const emptyIndex = {
	get: async () => ({denyRead: [], askRead: [], denyWrite: [], askWrite: [], denyExport: [], rulesFiles: [], problems: [], truncated: false, builtAt: Date.now(), persisted: true}),
	layout: async () => undefined,
	setLayoutSource() {},
} as unknown as RulesIndexReader;

describe('the index only adds', () => {
	it('an index that lists nothing never lifts a live deny, and a file made after the build is denied', async () => {
		const root = tempDir('live');
		const repo = path.join(root, 'repo');
		put(path.join(repo, '.yenarules'), '[deny read]\n.env\nlater/\n[ask write]\npackage.json\n');
		const scope: RulesScope = {roots: [repo], index: emptyIndex};
		put(path.join(repo, '.env'));
		assert.equal((await rulesVerdict(path.join(repo, '.env'), scope)).read, 'deny');
		assert.equal((await rulesVerdict(path.join(repo, 'later', 'new.txt'), scope)).read, 'deny');
		assert.equal((await rulesVerdict(path.join(repo, 'package.json'), scope)).write, 'ask');
		assert.equal((await rulesVerdict(path.join(repo, 'free.txt'), scope)).read, 'free');
	});

	it('a tampered index file is refused: relative, dotted, wrong type, NUL and oversized entries', () => {
		const good = {v: 1, builtAt: 1, layout: {modules: []}, watch: [], denyRead: [], askRead: [], denyWrite: [], askWrite: [], denyExport: [], rulesFiles: [], problems: [], truncated: false};
		assert.ok(parseStored(JSON.stringify(good)));
		const bad = (patch: object) => assert.equal(parseStored(JSON.stringify({...good, ...patch})), undefined, JSON.stringify(patch));
		bad({denyRead: ['rel/path']});
		bad({denyRead: ['/a/../etc']});
		bad({denyWrite: ['/a/./b']});
		bad({askRead: [1]});
		bad({denyExport: ['/a\u0000b']});
		bad({denyRead: 'x'});
		bad({watch: [['rel', 'k']]});
		bad({layout: {modules: [{name: 'm', codeDir: 'rel', dataDir: '/d'}]}});
		bad({truncated: 'no'});
	});

	it('an index file that was altered to list nothing is rebuilt from the rules files', async () => {
		const root = tempDir('tamper');
		const repo = path.join(root, 'repo');
		const dataDir = path.join(root, 'data', 'claude');
		put(path.join(repo, '.yenarules'), '[deny read]\nsecret\n');
		put(path.join(repo, 'secret'));
		put(path.join(root, 'data', 'keep'));
		const reader = rulesIndex(dataDir, {root: repo});
		reader.setLayoutSource(async () => ({root: repo, modules: []}));
		await reader.get({force: true});
		const file = path.join(rulesDataDirFor(dataDir), 'index.json');
		const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
		stored.denyRead = [];
		writeFileSync(file, JSON.stringify(stored));
		resetIndexMemo();
		const fresh = rulesIndex(dataDir, {root: repo});
		fresh.setLayoutSource(async () => ({root: repo, modules: []}));
		const lists = await fresh.get({force: true});
		assert.deepEqual(lists.denyRead, [path.join(repo, 'secret')]);
		assert.equal((await rulesVerdict(path.join(repo, 'secret'), {roots: [repo], index: fresh})).read, 'deny');
	});
});

describe('export fails closed', () => {
	const reader = (root: string) => rulesIndex(path.join(root, 'data', 'rules-test'), {root});

	it('a deny read file in the data folder is not exported by a legacy list or a bare header', async () => {
		const root = tempDir('dr');
		const [m] = makeModules(root, ['m']) as [ModuleDirs];
		put(path.join(m.codeDir, '.yenarules'), '[deny read]\n@secret.json\n@vault/\n');
		const provider = createExportProvider(reader(root));
		assert.equal(await provider.exportFilter(m, 'data'), undefined, 'no header, no legacy list: nothing is exported');
		const legacy = await provider.exportFilter({...m, legacyExport: {deny: []}}, 'data');
		assert.equal(await legacy?.denied('secret.json', false), true, 'legacy list must still close a deny read data file');
		assert.equal(await legacy?.denied('vault/a', false), true, 'legacy list must still close a deny read data folder');
		assert.equal(await legacy?.denied('other.json', false), false);
	});

	it('a deny read file created after the index was built is still denied', async () => {
		const root = tempDir('late');
		const [m] = makeModules(root, ['m']) as [ModuleDirs];
		put(path.join(m.codeDir, '.yenarules'), '[deny export]\n@out/**\n');
		const r = reader(root);
		r.setLayoutSource(async () => ({root, modules: [m]}));
		await r.get({force: true});
		const filter = await createExportProvider(r).exportFilter(m, 'data');
		put(path.join(m.dataDir, 'out', 'brand-new.bin'));
		assert.equal(await filter?.denied('out/brand-new.bin', false), true);
		assert.equal(await filter?.denied('ok.txt', false), false);
	});

	it('a malformed root file or a symlinked one exports nothing, for any legacy list', async () => {
		const root = tempDir('mal');
		const [m, n] = makeModules(root, ['m', 'n']) as [ModuleDirs, ModuleDirs];
		put(path.join(m.codeDir, '.yenarules'), '[unknown]\n');
		const provider = createExportProvider(reader(root));
		assert.equal(await (await provider.exportFilter({...m, legacyExport: {deny: []}}, 'data'))?.denied('a', false), true);
		put(path.join(root, 'real.yenarules'), '[deny export]\n');
		symlinkSync(path.join(root, 'real.yenarules'), path.join(n.codeDir, '.yenarules'));
		assert.equal(await (await provider.exportFilter({...n, legacyExport: {deny: []}}, 'data'))?.denied('a', false), true);
	});
});

describe('rules add only tightens', () => {
	const world = () => {
		const root = tempDir('tight');
		const workplace = path.join(root, 'workplace');
		const app = path.join(workplace, 'app');
		put(path.join(app, 'f'));
		const access: ProjectAccess = {roots: [workplace], docs: '', managed: [], writable: [app]};
		const projects: ProjectReader = {read: async () => access, rulesFile: () => undefined};
		return {app, projects};
	};

	it('adding ask lines leaves an existing deny in force', async () => {
		const w = world();
		put(path.join(w.app, '.yenarules'), '[deny read]\nsecret.txt\n[deny write]\nlock.json\n');
		await appendRules({target: {file: w.app}, section: 'ask read', patterns: ['secret.txt']}, {projects: w.projects});
		await appendRules({target: {file: w.app}, section: 'ask write', patterns: ['lock.json']}, {projects: w.projects});
		resetParseCache();
		const scope: RulesScope = {roots: [w.app]};
		assert.equal((await rulesVerdict(path.join(w.app, 'secret.txt'), scope)).read, 'deny');
		assert.equal((await rulesVerdict(path.join(w.app, 'lock.json'), scope)).write, 'deny');
	});

	it('parallel adds lose no reported line', async () => {
		const w = world();
		put(path.join(w.app, '.yenarules'), '[deny read]\nfirst\n');
		const results = await Promise.allSettled(
			Array.from({length: 6}, (_, i) => appendRules({target: {file: w.app}, section: 'deny read', patterns: [`p${i}`]}, {projects: w.projects})),
		);
		const text = readFileSync(path.join(w.app, '.yenarules'), 'utf8');
		const ok = results.flatMap((r, i) => (r.status === 'fulfilled' ? [`p${i}`] : []));
		assert.ok(ok.length >= 1);
		for (const p of ok) assert.ok(text.split('\n').includes(p), `${p} was reported added but is missing`);
		assert.equal(text.split('\n').filter(l => /^p\d$/.test(l)).length, ok.length);
		assert.equal(text.startsWith('[deny read]\nfirst\n'), true);
	});
});

describe('migration', () => {
	it('is idempotent and never goes through a symlinked rules file', async () => {
		const root = tempDir('mig2');
		const [m, n] = makeModules(root, ['m', 'n']) as [ModuleDirs, ModuleDirs];
		const layout: RulesLayout = {modules: [{...m, legacyExport: {deny: ['a']}}, {...n, legacyExport: {deny: ['b']}}]};
		const real = put(path.join(root, 'real'), '# mine\n');
		symlinkSync(real, path.join(n.codeDir, '.yenarules'));
		await migrateLegacyExports(layout, quietLog);
		const once = readFileSync(path.join(m.codeDir, '.yenarules'), 'utf8');
		const second = await migrateLegacyExports(layout, quietLog);
		assert.equal(second.migrated, 0);
		assert.equal(readFileSync(path.join(m.codeDir, '.yenarules'), 'utf8'), once);
		assert.equal(readFileSync(real, 'utf8'), '# mine\n');
	});
});
