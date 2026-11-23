import {type Expansion, expandRules, type RulesScope} from './engine.js';
import {resetParseCache} from './engine.js';
import {resetIndexMemo} from './index-store.js';

export {
	type Expansion,
	type Level,
	type Problem,
	type RulesScope,
	type RulesVerdict,
	type Section,
	entriesInside,
	exportVerdict,
	loadRules,
	parseRules,
	RULES_FILE,
	rulesVerdict,
	SECTIONS,
} from './engine.js';
export {INDEX_MAX_AGE_MS, type RulesIndexReader, type RulesLists, rulesIndex} from './index-store.js';

export function resetRulesCaches(): void {
	resetParseCache();
	resetIndexMemo();
}

export function rulesLists(scope: RulesScope, opts: {maxAgeMs?: number; force?: boolean} = {}): Promise<Expansion> {
	return scope.index ? scope.index.get(opts) : expandRules(scope);
}
