import assert from 'node:assert/strict';
import {mkdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {beforeEach, describe, it} from 'node:test';
import type {CommandContext, ModuleDirs, PluginHost, RulesProvider} from '../../../src/api.js';
import {createRulesCommand} from '../src/commands.js';
import {resetParseCache} from '../src/engine.js';
import plugin from '../src/index.js';
import {resetIndexMemo, rulesIndex} from '../src/index-store.js';
import {makeModules, put, quietLog, tempDir} from './helpers.js';

beforeEach(() => {
	resetParseCache();
	resetIndexMemo();
});

function ctxOf(headless = false) {
	const out: string[] = [];
	const ctx = {print: (t: string) => void out.push(t), headless, showHelp: () => void out.push('HELP')} as unknown as CommandContext;
	return {ctx, out};
}

function setup() {
	const root = tempDir('cmd');
	const repo = path.join(root, 'repo');
	mkdirSync(repo, {recursive: true});
	const modules = makeModules(root, ['m']);
	const reader = rulesIndex(path.join(root, 'data', 'rules-mod'), {root: repo});
	reader.setLayoutSource(async () => ({root: repo, modules}));
	return {root, repo, modules, reader};
}

describe('rules command', () => {
	it('is autostarted and safe, with index and add subcommands', () => {
		const {reader} = setup();
		const cmd = createRulesCommand({reader, projects: () => undefined, log: quietLog});
		assert.equal(cmd.autostart, true);
		assert.equal(cmd.agent, 'safe');
		assert.deepEqual(cmd.subcommands?.map(s => [s.name, s.agent]), [['index', 'safe'], ['add', 'safe']]);
	});

	it('rules index lists the files with their state and the section counts', async () => {
		const {repo, reader} = setup();
		put(path.join(repo, '.yenarules'), '[deny read]\n.env\n');
		put(path.join(repo, 'sub', '.yenarules'), '[nope]\n');
		put(path.join(repo, '.env'));
		const {ctx, out} = ctxOf();
		await createRulesCommand({reader, projects: () => undefined, log: quietLog}).run(['index'], ctx);
		const text = out.join('\n');
		assert.match(text, /sub\/\.yenarules.*malformed: line 1, unknown section header/);
		assert.match(text, /deny read\s+2/);
		assert.match(text, /Indexed 2 files in \d+ ms/);
	});

	it('autostart reports only problems, once, without a headless run building', async () => {
		const {repo, reader} = setup();
		put(path.join(repo, '.yenarules'), '[bad]\n');
		const headless = ctxOf(true);
		const cmd = createRulesCommand({reader, projects: () => undefined, log: quietLog});
		await cmd.run([], headless.ctx);
		await new Promise(r => setTimeout(r, 50));
		assert.deepEqual(headless.out, []);
		const live = ctxOf();
		const cmd2 = createRulesCommand({reader, projects: () => undefined, log: quietLog});
		await cmd2.run([], live.ctx);
		await new Promise(r => setTimeout(r, 200));
		assert.equal(live.out.length, 1);
		assert.match(live.out[0] ?? '', /^Warning: .*\.yenarules line 1: unknown section header\. Everything in its folder is closed to the assistant until you fix it\.$/);
		await cmd2.run([], live.ctx);
		assert.equal(live.out.at(-1), 'HELP');
	});

	it('autostart migrates the legacy export lists after the build', async () => {
		const {reader, modules} = setup();
		const [m] = modules as [ModuleDirs];
		const layout = async () => ({modules: [{...m, legacyExport: {deny: ['state.json']}}]});
		const {ctx} = ctxOf();
		await createRulesCommand({reader, projects: () => undefined, log: quietLog, layout}).run([], ctx);
		await new Promise(r => setTimeout(r, 300));
		assert.match(readFileSync(path.join(m.codeDir, '.yenarules'), 'utf8'), /\[deny export\]\n@state\.json\n$/);
	});

	it('rules add reports the change and refuses bad calls with a usage error', async () => {
		const {repo, reader} = setup();
		const projects = {read: async () => ({roots: [path.dirname(repo), path.join(path.dirname(repo), 's')], docs: '', managed: [], writable: [repo]})};
		const cmd = createRulesCommand({reader, projects: () => projects, log: quietLog});
		const {ctx, out} = ctxOf();
		await cmd.run(['add', '--file', repo, 'deny read', '*.pem'], ctx);
		assert.match(out[0] ?? '', /^Added 1 line to \[deny read\] in .*\.yenarules \(new file\)$/);
		assert.equal(readFileSync(path.join(repo, '.yenarules'), 'utf8').endsWith('[deny read]\n*.pem\n'), true);
		await assert.rejects(async () => cmd.run(['add', 'deny read'], ctx), /Usage: rules add/);
		await assert.rejects(async () => cmd.run(['add', '--file', repo, '--project', 'x', 'deny read', 'a'], ctx), /Usage: rules add/);
		await assert.rejects(async () => cmd.run(['nope'], ctx), /Unknown subcommand/);
	});
});

describe('plugin', () => {
	const hostOf = (extra: Partial<PluginHost>, dataDir: string) => ({dataDir, ...extra}) as unknown as PluginHost;

	it('registers the export provider and feeds the layout to the index', async () => {
		const root = tempDir('plug');
		let provider: RulesProvider | undefined;
		const commands = await plugin(
			hostOf(
				{
					registerRulesProvider: p => {
						provider = p;
						return {layout: async () => ({modules: []})};
					},
				},
				path.join(root, 'rules'),
			),
		);
		assert.equal(commands[0]?.name, 'rules');
		assert.equal(typeof provider?.exportFilter, 'function');
	});

	it('works without the host hook, only logging that no provider was registered', async () => {
		const root = tempDir('plug2');
		const warns: string[] = [];
		const log = {...quietLog, warn: (m: string) => void warns.push(m), child: () => log};
		const commands = await plugin(hostOf({log}, path.join(root, 'rules')));
		assert.equal(commands.length, 1);
		assert.deepEqual(warns, ['rules provider unavailable']);
	});
});
