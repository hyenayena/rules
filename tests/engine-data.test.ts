import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {beforeEach, describe, it} from 'node:test';
import type {ModuleDirs} from '../../../src/api.js';
import {exportVerdict, expandRules, parseRules, resetParseCache, rulesVerdict, type RulesScope} from '../src/engine.js';
import {makeModules, put, tempDir} from './helpers.js';

beforeEach(() => resetParseCache());

const bad = (text: string, problem: RegExp, line: number, dataAllowed = true) => {
	const r = parseRules(text, {dataAllowed});
	assert.equal(r.ok, false, text);
	if (!r.ok) {
		assert.match(r.problem, problem);
		assert.equal(r.line, line);
	}
};

describe('parseRules "@" and [deny export]', () => {
	it('accepts [deny export] and keeps @ lines apart from code lines', () => {
		const r = parseRules('[deny export]\n@state.json\n*.key\n\\@literal\n', {dataAllowed: true});
		assert.ok(r.ok);
		if (r.ok) {
			assert.equal(r.data['deny export'].length, 1);
			assert.equal(r.sections['deny export'].length, 2);
			assert.ok(r.declared.has('deny export'));
		}
	});

	it('refuses "@" outside a module root and "@/"', () => {
		bad('[deny read]\n@x\n', /valid only in a module's root/, 2, false);
		bad('[deny read]\n!@x\n', /valid only in a module's root/, 2, false);
		bad('[deny read]\n@/x\n', /not by "\/"/, 2);
		bad('[deny read]\n@\n', /empty/, 2);
		assert.ok(parseRules('[deny read]\n\\@x\n', {dataAllowed: false}).ok);
	});

	it('the pattern after "@" is anchored at the data folder', () => {
		const r = parseRules('[deny read]\n@x\n@**/y\n@d/**\n', {dataAllowed: true});
		assert.ok(r.ok);
	});
});

describe('data folder verdicts', () => {
	const setup = () => {
		const root = tempDir('data');
		const [m] = makeModules(root, ['m']) as [ModuleDirs];
		const scope: RulesScope = {roots: [path.join(root, 'nothing')], modules: async () => [m]};
		return {root, m, scope, rootFile: path.join(m.codeDir, '.yenarules')};
	};

	it('judges a path in the data folder by the module root "@" lines, anchored', async () => {
		const {m, scope, rootFile} = setup();
		put(rootFile, '[deny read]\n@state.json\n[ask write]\n@**/note.md\n');
		put(path.join(m.dataDir, 'state.json'));
		put(path.join(m.dataDir, 'sub', 'state.json'));
		put(path.join(m.dataDir, 'sub', 'note.md'));
		const v = await rulesVerdict(path.join(m.dataDir, 'state.json'), scope);
		assert.equal(v.read, 'deny');
		assert.equal((await rulesVerdict(path.join(m.dataDir, 'sub', 'state.json'), scope)).read, 'free');
		assert.equal((await rulesVerdict(path.join(m.dataDir, 'sub', 'note.md'), scope)).write, 'ask');
	});

	it('a malformed root file closes the data folder', async () => {
		const {m, scope, rootFile} = setup();
		put(rootFile, '[deny read]\n@/x\n');
		const v = await rulesVerdict(path.join(m.dataDir, 'anything'), scope);
		assert.equal(v.read, 'deny');
		assert.equal(v.kind, 'malformed');
	});

	it('expansion lists data paths and closes a malformed module data folder', async () => {
		const {root, m, scope, rootFile} = setup();
		put(rootFile, '[deny read]\n@keep/**\n[deny export]\n@tmp\n');
		put(path.join(m.dataDir, 'keep', 'a'));
		put(path.join(m.dataDir, 'tmp', 'b'));
		put(path.join(m.dataDir, 'free'));
		const e = await expandRules(scope);
		assert.deepEqual(e.denyRead, [path.join(m.dataDir, 'keep')]);
		assert.deepEqual(e.denyExport.sort(), [path.join(m.dataDir, 'keep'), path.join(m.dataDir, 'tmp')].sort());
		put(rootFile, '[deny export]\n@/x\n');
		const closed = await expandRules(scope);
		assert.ok(closed.denyRead.includes(m.dataDir));
		assert.equal(closed.problems.length, 1);
		assert.ok(root);
	});

	it('exportVerdict: data lines, deny read implied, malformed closes, code chain', async () => {
		const {m, rootFile} = setup();
		put(rootFile, '[deny read]\n@secret\n[deny export]\n@tmp/**\n*.key\n');
		assert.equal(await exportVerdict(path.join(m.dataDir, 'tmp', 'x'), m), true);
		assert.equal(await exportVerdict(path.join(m.dataDir, 'secret', 'x'), m), true);
		assert.equal(await exportVerdict(path.join(m.dataDir, 'a.key'), m), false, 'code lines do not touch data');
		assert.equal(await exportVerdict(path.join(m.codeDir, 'a.key'), m), true);
		assert.equal(await exportVerdict(path.join(m.codeDir, 'src', 'a.ts'), m), false);
		put(rootFile, '[bogus]\n');
		assert.equal(await exportVerdict(path.join(m.dataDir, 'x'), m), true);
		mkdirSync(path.join(m.codeDir, 'src'), {recursive: true});
		assert.equal(await exportVerdict(path.join(m.codeDir, 'src'), m, true), true);
	});

	it('an "@" file that is not a module root is malformed and closes its folder', async () => {
		const root = tempDir('notroot');
		put(path.join(root, 'repo', '.yenarules'), '[deny read]\n@x\n');
		put(path.join(root, 'repo', 'f'));
		const v = await rulesVerdict(path.join(root, 'repo', 'f'), {roots: [path.join(root, 'repo')]});
		assert.equal(v.read, 'deny');
		assert.equal(v.kind, 'malformed');
	});
});
