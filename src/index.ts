import type {ModulePlugin, RulesLayout} from '../../../src/api.js';
import {createRulesCommand} from './commands.js';
import {loadProjectReader} from './deps/project.js';
import {createExportProvider} from './export-filter.js';
import {rulesIndex} from './index-store.js';
import {noopLog} from './log.js';

const plugin: ModulePlugin = async host => {
	const log = (host.log ?? noopLog).child('rules');
	const reader = rulesIndex(host.dataDir);
	const projects = await loadProjectReader(host.dataDir);
	reader.setProjects(projects);
	let layout: (() => Promise<RulesLayout>) | undefined;
	if (typeof host.registerRulesProvider === 'function') {
		const access = host.registerRulesProvider(createExportProvider(reader));
		layout = access.layout;
		reader.setLayoutSource(access.layout);
	} else {
		log.warn('rules provider unavailable');
	}
	return [createRulesCommand({reader, projects: () => projects, log, layout})];
};

export default plugin;
