import assert from 'node:assert/strict';
import {chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {beforeEach, describe, it} from 'node:test';
import {appendRules, composeAppend, NEW_FILE_HEADER} from '../src/append.js';
import type {ProjectAccess, ProjectReader} from '../src/deps/project.js';
import {resetParseCache} from '../src/engine.js';
import {put, tempDir} from './helpers.js';

beforeEach(() => resetParseCache());

const kind = async (p: Promise<unknown>, kindName: string, message?: RegExp) =>
	assert.rejects(p, (e: Error & {kind?: string}) => e.kind === kindName && (message === undefined || message.test(e.message)));

function world(isolated: string[] = ['app']) {
	const root = tempDir('add');
	const workplace = path.join(root, 'workplace');
	const stage = path.join(root, 'stage');
	const rulesDir = path.join(root, 'prules');
	mkdirSync(path.join(workplace, 'app'), {recursive: true});
	mkdirSync(path.join(workplace, 'other'), {recursive: true});
	mkdirSync(path.join(stage, 'app-stage-1'), {recursive: true});
	mkdirSync(rulesDir);
	const access: ProjectAccess = {
		roots: [workplace, stage],
		docs: path.join(root, 'docs'),
		managed: [],
		writable: isolated.flatMap(n => [path.join(workplace, n), path.join(stage, `${n}-stage-1`)]),
		stages: [{path: path.join(stage, 'app-stage-1'), project: 'app'}],
	};
	const projects: ProjectReader = {read: async () => access, rulesFile: n => path.join(rulesDir, `${n}.yenarules`)};
	return {root, workplace, stage, rulesDir, projects};
}

describe('composeAppend', () => {
	it('adds at the end, reusing the last header only when it is the same section', () => {
		assert.equal(composeAppend('[deny read]\na\n', 'deny read', ['b']), '[deny read]\na\nb\n');
		assert.equal(composeAppend('[deny read]\na\n', 'ask write', ['b']), '[deny read]\na\n\n[ask write]\nb\n');
		assert.equal(composeAppend('[deny read]\na\n[ask write]\nc', 'deny read', ['b']), '[deny read]\na\n[ask write]\nc\n\n[deny read]\nb\n');
		assert.equal(composeAppend('', 'deny read', ['b']), '[deny read]\nb\n');
	});
});

describe('rules add', () => {
	it('appends to an existing file in an isolated project, keeping its mode', async () => {
		const w = world();
		const file = put(path.join(w.workplace, 'app', '.yenarules'), '[deny read]\n.env\n');
		chmodSync(file, 0o640);
		const r = await appendRules({target: {file: path.join(w.workplace, 'app')}, section: 'deny-read', patterns: ['*.pem', 'x/']}, {projects: w.projects});
		assert.deepEqual([r.created, r.lines, r.section, r.kind], [false, 2, 'deny read', 'repo']);
		assert.equal(readFileSync(file, 'utf8'), '[deny read]\n.env\n*.pem\nx/\n');
		assert.equal(lstatSync(file).mode & 0o777, 0o640);
		assert.deepEqual(readdirSync(path.join(w.workplace, 'app')), ['.yenarules']);
	});

	it('creates a new file with the usual first line, and a stage of an isolated project works', async () => {
		const w = world();
		const r = await appendRules({target: {file: path.join(w.stage, 'app-stage-1', '.yenarules')}, section: 'ask write', patterns: ['/src/x.ts']}, {projects: w.projects});
		assert.equal(r.created, true);
		const file = path.join(w.stage, 'app-stage-1', '.yenarules');
		assert.equal(readFileSync(file, 'utf8'), `${NEW_FILE_HEADER}\n\n[ask write]\n/src/x.ts\n`);
		assert.equal(lstatSync(file).mode & 0o777, 0o644);
	});

	it('refuses a project that is not isolated, /app and anything outside the project folders', async () => {
		const w = world();
		await kind(appendRules({target: {file: path.join(w.workplace, 'other')}, section: 'deny read', patterns: ['a']}, {projects: w.projects}), 'not-isolated', /project isolate other/);
		await kind(appendRules({target: {file: w.root}, section: 'deny read', patterns: ['a']}, {projects: w.projects}), 'invalid', /by hand/);
		await kind(appendRules({target: {file: w.workplace}, section: 'deny read', patterns: ['a']}, {projects: w.projects}), 'invalid');
		await kind(appendRules({target: {file: path.join(w.workplace, 'app')}, section: 'deny read', patterns: ['a']}, {}), 'invalid');
	});

	it('refuses patterns that loosen or break the file', async () => {
		const w = world();
		const target = {file: path.join(w.workplace, 'app')};
		const run = (patterns: string[], section = 'deny read') => appendRules({target, section, patterns}, {projects: w.projects});
		await kind(run(['!x']), 'invalid', /re-open/);
		await kind(run(['# c']), 'invalid');
		await kind(run(['[deny read]']), 'invalid', /header/);
		await kind(run(['a\nb']), 'invalid', /control/);
		await kind(run(['a\u0000b']), 'invalid', /control/);
		await kind(run(['']), 'invalid');
		await kind(run(['a'.repeat(201)]), 'invalid');
		await kind(run(Array.from({length: 33}, (_, i) => `f${i}`)), 'invalid', /At most/);
		await kind(run([]), 'usage');
		await kind(run(['a ']), 'invalid');
		await kind(run(['@x']), 'invalid', /valid only in a module's root/);
		await kind(run(['a/../b']), 'invalid', /malformed/);
		await kind(run(['a'], 'nonsense'), 'invalid', /Unknown section/);
		assert.equal(existsSync(path.join(w.workplace, 'app', '.yenarules')), false);
		assert.deepEqual(readdirSync(path.join(w.workplace, 'app')), []);
	});

	it('refuses a malformed existing file, a symlink and a non-regular file', async () => {
		const w = world();
		const dir = path.join(w.workplace, 'app');
		const file = put(path.join(dir, '.yenarules'), '[nope]\n');
		await kind(appendRules({target: {file: dir}, section: 'deny read', patterns: ['a']}, {projects: w.projects}), 'invalid', /malformed/);
		writeFileSync(file, '[deny read]\n');
		const real = put(path.join(w.root, 'real.yenarules'), '[deny read]\n');
		const link = path.join(w.workplace, 'app', 'sub');
		mkdirSync(link);
		symlinkSync(real, path.join(link, '.yenarules'));
		await kind(appendRules({target: {file: link}, section: 'deny read', patterns: ['a']}, {projects: w.projects}), 'invalid', /regular file/);
		assert.equal(readFileSync(real, 'utf8'), '[deny read]\n');
		const viaLink = path.join(w.workplace, 'app', 'viaLink');
		symlinkSync(path.join(w.workplace, 'other'), viaLink);
		await kind(appendRules({target: {file: viaLink}, section: 'deny read', patterns: ['a']}, {projects: w.projects}), 'invalid', /not a real folder|symlink/);
		await kind(appendRules({target: {file: path.join(dir, 'missing')}, section: 'deny read', patterns: ['a']}, {projects: w.projects}), 'not-found');
	});

	it('will not add a first [deny export] header to a module root, but extends an existing list', async () => {
		const w = world();
		const mod = path.join(w.workplace, 'app', 'modules', 'm');
		put(path.join(mod, 'yena.json'), '{}');
		await kind(appendRules({target: {file: mod}, section: 'deny export', patterns: ['@x']}, {projects: w.projects}), 'invalid', /no \[deny export\] list/);
		put(path.join(mod, '.yenarules'), '[deny export]\n@a\n');
		await appendRules({target: {file: mod}, section: 'deny export', patterns: ['@b']}, {projects: w.projects});
		assert.equal(readFileSync(path.join(mod, '.yenarules'), 'utf8'), '[deny export]\n@a\n@b\n');
		await appendRules({target: {file: mod}, section: 'deny read', patterns: ['@c']}, {projects: w.projects});
		assert.match(readFileSync(path.join(mod, '.yenarules'), 'utf8'), /\[deny read\]\n@c\n$/);
	});

	it('a project rules file needs no isolation but must exist, and keeps its mode', async () => {
		const w = world([]);
		await kind(appendRules({target: {project: 'other'}, section: 'deny read', patterns: ['a']}, {projects: w.projects}), 'not-found', /project isolate other/);
		const file = put(path.join(w.rulesDir, 'other.yenarules'), '[deny read]\n.env\n');
		chmodSync(file, 0o600);
		const r = await appendRules({target: {project: 'other'}, section: 'deny read', patterns: ['secrets/']}, {projects: w.projects});
		assert.equal(r.kind, 'project');
		assert.equal(readFileSync(file, 'utf8'), '[deny read]\n.env\nsecrets/\n');
		assert.equal(lstatSync(file).mode & 0o777, 0o600);
		await kind(appendRules({target: {project: 'x'}, section: 'deny read', patterns: ['a']}, {}), 'invalid');
	});

	it('refuses a result over the size limit', async () => {
		const w = world();
		const big = '[deny read]\n' + Array.from({length: 2000}, (_, i) => `f${i}`).join('\n') + '\n';
		put(path.join(w.workplace, 'app', '.yenarules'), big);
		await kind(appendRules({target: {file: path.join(w.workplace, 'app')}, section: 'deny read', patterns: ['more']}, {projects: w.projects}), 'invalid', /too large|malformed/);
	});
});
