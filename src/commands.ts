import type {Command, CommandContext, Logger, RulesLayout} from '../../../src/api.js';
import {appendRules, type AppendTarget} from './append.js';
import {commandError, line, printStyled, sanitizeText as sanitize, span, table} from './deps/core.js';
import type {ProjectReader} from './deps/project.js';
import type {Problem} from './engine.js';
import {SECTIONS} from './engine.js';
import type {RulesIndexReader, RulesLists} from './index-store.js';
import {migrateLegacyExports} from './migrate.js';

export type RulesCommandDeps = {
	reader: RulesIndexReader;
	projects: () => ProjectReader | undefined;
	log: Logger;
	layout?: (() => Promise<RulesLayout>) | undefined;
};

const sanitizeText = (text: string, max = 300): string => sanitize(text, max);

const where = (p: Problem): string => `${sanitizeText(p.file)}${p.line === undefined ? '' : ` line ${p.line}`}`;

const warning = (p: Problem): string =>
	`Warning: ${where(p)}: ${sanitizeText(p.problem)}. Everything in its folder is closed to the assistant until you fix it.`;

async function rebuild(deps: RulesCommandDeps): Promise<{lists: RulesLists; ms: number}> {
	const started = Date.now();
	const lists = await deps.reader.get({force: true});
	const ms = Date.now() - started;
	deps.log.info('rules indexed', {
		files: lists.rulesFiles.length,
		problems: lists.problems.length,
		entries: lists.denyRead.length + lists.askRead.length + lists.denyWrite.length + lists.askWrite.length + lists.denyExport.length,
		truncated: lists.truncated,
		persisted: lists.persisted,
		ms,
	});
	return {lists, ms};
}

const truncatedNote = 'The listing hit its size limit, so some paths are missing from the index; the file tools still check every rule live.';

function summary(ctx: CommandContext, lists: RulesLists, ms: number): void {
	const blocks = [
		table(
			SECTIONS.map(s => [s, String({'deny read': lists.denyRead, 'ask read': lists.askRead, 'deny write': lists.denyWrite, 'ask write': lists.askWrite, 'deny export': lists.denyExport}[s].length)]),
			{head: ['Section', 'Paths']},
		),
		line(`Indexed ${lists.rulesFiles.length} files in ${ms} ms${lists.persisted ? '' : ' (the index file could not be written)'}`),
		...(lists.truncated ? [line(span(truncatedNote, {tone: 'warn'}))] : []),
	];
	printStyled(ctx, blocks);
}

async function runIndex(deps: RulesCommandDeps, ctx: CommandContext): Promise<void> {
	const {lists, ms} = await rebuild(deps);
	const bad = new Map(lists.problems.map(p => [p.file, p]));
	const rows = lists.rulesFiles.map(f => {
		const p = bad.get(f);
		return [sanitizeText(f), p === undefined ? 'ok' : span(`malformed: ${p.line === undefined ? '' : `line ${p.line}, `}${sanitizeText(p.problem)}`, {tone: 'warn'})];
	});
	for (const p of lists.problems) {
		if (!lists.rulesFiles.includes(p.file)) rows.push([sanitizeText(p.file), span(`malformed: ${p.line === undefined ? '' : `line ${p.line}, `}${sanitizeText(p.problem)}`, {tone: 'warn'})]);
	}
	if (rows.length > 0) printStyled(ctx, [table(rows, {head: ['Rules file', 'State']})]);
	summary(ctx, lists, ms);
}

function parseAdd(args: string[]): {target: AppendTarget; section: string; patterns: string[]} {
	let target: AppendTarget | undefined;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i] as string;
		if (a === '--file' || a === '--project') {
			const value = args[++i];
			if (value === undefined || target !== undefined) throw commandError('usage', 'Usage: rules add [--file <path> | --project <name>] <section> <pattern>…');
			target = a === '--file' ? {file: value} : {project: value};
		} else {
			rest.push(a);
		}
	}
	const [section, ...patterns] = rest;
	if (section === undefined || patterns.length === 0) throw commandError('usage', 'Usage: rules add [--file <path> | --project <name>] <section> <pattern>…');
	return {target: target ?? {file: process.cwd()}, section, patterns};
}

async function runAdd(deps: RulesCommandDeps, ctx: CommandContext, args: string[]): Promise<void> {
	const req = parseAdd(args);
	const result = await appendRules(req, {projects: deps.projects()});
	deps.log.info('rules added', {target: result.kind, section: result.section, lines: result.lines, created: result.created});
	ctx.print(`Added ${result.lines} line${result.lines === 1 ? '' : 's'} to [${result.section}] in ${sanitizeText(result.file)}${result.created ? ' (new file)' : ''}`);
	const {lists, ms} = await rebuild(deps);
	summary(ctx, lists, ms);
}

async function startBackground(deps: RulesCommandDeps, ctx: CommandContext): Promise<void> {
	try {
		let {lists} = await rebuild(deps);
		const layout = deps.layout === undefined ? undefined : await deps.layout().catch(() => undefined);
		if (layout !== undefined) {
			const migrated = await migrateLegacyExports(layout, deps.log);
			if (migrated.migrated > 0) lists = (await rebuild(deps)).lists;
		}
		for (const p of lists.problems) ctx.print(warning(p));
		if (lists.truncated) ctx.print(truncatedNote);
	} catch (error) {
		deps.log.warn('rules index failed', {err: error});
	}
}

export function createRulesCommand(deps: RulesCommandDeps): Command {
	let started = false;
	return {
		name: 'rules',
		description: 'Check the .yenarules files and add rules to them',
		usage: 'rules <subcommand>',
		args: [{name: 'subcommand', description: 'index | add'}],
		autostart: true,
		agent: 'safe',
		subcommands: [
			{
				name: 'index',
				usage: 'rules index',
				description: 'Find and check every rules file and list the paths they close',
				agent: 'safe',
			},
			{
				name: 'add',
				usage: 'rules add [--file <path> | --project <name>] <section> <pattern>…',
				description: 'Add rules that close more to a .yenarules file',
				agent: 'safe',
				args: [
					{name: 'section', description: 'deny read, ask read, deny write, ask write or deny export (quote it or write deny-read)'},
					{name: 'pattern', description: 'The path pattern to add', repeatable: true},
				],
				options: [
					{name: '--file', value: 'path', description: 'The .yenarules file, or the folder that holds it (default: the current folder)'},
					{name: '--project', value: 'name', description: "A project's rules file"},
				],
				notes: [
					'Lines starting with ! are refused: rules add only closes more.',
					'@ is the module\'s data folder and works only in a module\'s root .yenarules.',
					'A file inside a project needs that project isolated.',
				],
			},
		],
		async run(args, ctx) {
			const [sub, ...rest] = args;
			if (sub === undefined) {
				if (!started) {
					started = true;
					if (ctx.headless !== true) void startBackground(deps, ctx);
					return;
				}
				if (ctx.showHelp) ctx.showHelp();
				else ctx.print('rules <subcommand>');
				return;
			}
			started = true;
			if (sub === 'index') {
				if (rest.length > 0) throw commandError('usage', 'Usage: rules index');
				await runIndex(deps, ctx);
			} else if (sub === 'add') {
				await runAdd(deps, ctx, rest);
			} else {
				throw commandError('usage', `Unknown subcommand: ${sanitizeText(sub).slice(0, 64)}. See "rules help"`);
			}
		},
	};
}
