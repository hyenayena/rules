import assert from 'node:assert/strict';
import {chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {beforeEach, describe, it} from 'node:test';
import type {RulesLayout} from '../../../src/api.js';
import {resetParseCache} from '../src/engine.js';
import {parseStored, resetIndexMemo, rulesDataDirFor, rulesIndex} from '../src/index-store.js';
import {makeModules, put, tempDir} from './helpers.js';

beforeEach(() => {
	resetParseCache();
	resetIndexMemo();
});

const setup = (name: string) => {
	const root = tempDir(name);
	const modules = makeModules(root, ['m']);
	const dataDir = path.join(root, 'data', 'claude');
	const repo = path.join(root, 'repo');
	mkdirSync(repo, {recursive: true});
	const layout: RulesLayout = {root: repo, modules};
	const reader = rulesIndex(dataDir, {root: repo});
	reader.setLayoutSource(async () => layout);
	return {root, repo, modules, dataDir, reader, indexFile: path.join(rulesDataDirFor(dataDir), 'index.json')};
};

describe('rules index', () => {
	it('builds the lists, writes a 0600 file in a 0700 folder and holds paths only', async () => {
		const {repo, reader, indexFile, dataDir} = setup('build');
		put(path.join(repo, '.yenarules'), '[deny read]\n.env\n[deny export]\nout/\n');
		put(path.join(repo, '.env'));
		put(path.join(repo, 'out', 'a'));
		const lists = await reader.get({force: true});
		assert.deepEqual(lists.denyRead, [path.join(repo, '.env')]);
		assert.deepEqual(lists.denyExport.sort(), [path.join(repo, '.env'), path.join(repo, 'out')].sort());
		assert.equal(lists.persisted, true);
		assert.equal(lstatSync(indexFile).mode & 0o777, 0o600);
		assert.equal(lstatSync(rulesDataDirFor(dataDir)).mode & 0o777, 0o700);
		const stored = parseStored(readFileSync(indexFile, 'utf8'));
		assert.ok(stored);
		assert.deepEqual(stored.denyRead, lists.denyRead);
	});

	it('rebuilds when a rules file changes, and is reused when nothing changed', async () => {
		const {repo, reader} = setup('refresh');
		const file = put(path.join(repo, '.yenarules'), '[deny read]\na\n');
		put(path.join(repo, 'a'));
		put(path.join(repo, 'b'));
		const first = await reader.get();
		assert.equal((await reader.get()).builtAt, first.builtAt);
		put(file, '[deny read]\na\nb\n');
		assert.deepEqual((await reader.get()).denyRead.sort(), [path.join(repo, 'a'), path.join(repo, 'b')]);
	});

	it('rebuilds a stale index for a chat consumer, and picks up a new top-level rules file', async () => {
		const {repo, reader} = setup('age');
		put(path.join(repo, 'x'));
		assert.deepEqual((await reader.get({maxAgeMs: 15_000})).denyRead, []);
		put(path.join(repo, '.yenarules'), '[deny read]\nx\n');
		assert.deepEqual((await reader.get()).denyRead, [path.join(repo, 'x')], 'the folder mtime moved');
		await new Promise(r => setTimeout(r, 5));
		const again = await reader.get({maxAgeMs: 0});
		assert.ok(again.builtAt >= 0);
	});

	it('data lines of an installed module end up in the index; a malformed root closes its data', async () => {
		const {modules, reader} = setup('data');
		const [m] = modules as [(typeof modules)[number]];
		put(path.join(m.codeDir, '.yenarules'), '[deny read]\n@private\n');
		put(path.join(m.dataDir, 'private', 'a'));
		assert.deepEqual((await reader.get({force: true})).denyRead, [path.join(m.dataDir, 'private')]);
		put(path.join(m.codeDir, '.yenarules'), '[nope]\n');
		const closed = await reader.get({force: true});
		assert.ok(closed.denyRead.includes(m.dataDir));
		assert.ok(closed.problems.some(p => p.file.endsWith('.yenarules')));
	});

	it('another reader loads the persisted index and its layout', async () => {
		const {repo, reader, dataDir, modules} = setup('persist');
		put(path.join(repo, '.yenarules'), '[deny read]\nz\n');
		put(path.join(repo, 'z'));
		const built = await reader.get({force: true});
		resetIndexMemo();
		const other = rulesIndex(dataDir, {root: repo});
		assert.equal((await other.get()).builtAt, built.builtAt);
		assert.deepEqual((await other.layout())?.modules.map(m => m.name), modules.map(m => m.name));
	});

	it('rebuilds from an invalid, oversized or symlinked index file', async () => {
		const {repo, reader, indexFile, root} = setup('invalid');
		put(path.join(repo, '.yenarules'), '[deny read]\nz\n');
		put(path.join(repo, 'z'));
		await reader.get({force: true});
		writeFileSync(indexFile, '{"v":1,"denyRead":["relative"]}');
		resetIndexMemo();
		const fresh = rulesIndex(path.join(root, 'data', 'claude'), {root: repo});
		fresh.setLayoutSource(async () => ({root: repo, modules: []}));
		assert.deepEqual((await fresh.get()).denyRead, [path.join(repo, 'z')]);
		rmSync(indexFile);
		put(path.join(root, 'elsewhere.json'), '{}');
		symlinkSync(path.join(root, 'elsewhere.json'), indexFile);
		resetIndexMemo();
		const linked = rulesIndex(path.join(root, 'data', 'claude'), {root: repo});
		linked.setLayoutSource(async () => ({root: repo, modules: []}));
		const lists = await linked.get();
		assert.deepEqual(lists.denyRead, [path.join(repo, 'z')]);
		assert.equal(readFileSync(path.join(root, 'elsewhere.json'), 'utf8'), '{}', 'the link target is untouched');
	});

	it('keeps the lists in memory when the index cannot be written', async () => {
		const {repo, reader, dataDir} = setup('nowrite');
		put(path.join(repo, '.yenarules'), '[deny read]\nz\n');
		put(path.join(repo, 'z'));
		const dir = rulesDataDirFor(dataDir);
		mkdirSync(dir, {recursive: true});
		chmodSync(dir, 0o500);
		const lists = await reader.get({force: true});
		chmodSync(dir, 0o700);
		assert.deepEqual(lists.denyRead, [path.join(repo, 'z')]);
		if (process.getuid?.() !== 0) assert.equal(lists.persisted, false);
	});

	it('refuses a symlinked rules data folder', async () => {
		const {repo, reader, dataDir, root} = setup('linkdir');
		put(path.join(repo, '.yenarules'), '[deny read]\nz\n');
		mkdirSync(path.join(root, 'target'));
		mkdirSync(path.dirname(dataDir), {recursive: true});
		symlinkSync(path.join(root, 'target'), rulesDataDirFor(dataDir));
		const lists = await reader.get({force: true});
		assert.equal(lists.persisted, false);
		assert.equal(existsSync(path.join(root, 'target', 'index.json')), false);
	});

	it('parseStored refuses malformed content', () => {
		assert.equal(parseStored('nope'), undefined);
		assert.equal(parseStored('{"v":2}'), undefined);
	});
});
