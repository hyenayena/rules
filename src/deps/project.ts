import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export type ProjectAccess = {
	roots: string[];
	docs: string;
	managed: string[];
	writable: string[];
	stages?: Array<{path: string; project: string}>;
};

export type ProjectReader = {
	rulesFile?: (name: string) => string | undefined;
	read(): Promise<ProjectAccess | undefined>;
};

const ENTRY = new URL('../../../project/src/public.ts', import.meta.url);
const MANIFEST = new URL('../../../project/yena.json', import.meta.url);

const isReader = (v: unknown): v is ProjectReader => typeof (v as Partial<ProjectReader> | null)?.read === 'function';

export async function loadProjectReader(moduleDataDir: string): Promise<ProjectReader | undefined> {
	if (!existsSync(fileURLToPath(MANIFEST))) return undefined;
	try {
		const mod = (await import(ENTRY.href)) as {accessReader?: (dataDir: string) => unknown};
		const reader = typeof mod.accessReader === 'function' ? mod.accessReader(moduleDataDir) : undefined;
		if (isReader(reader)) return reader;
	} catch {
	}
	return undefined;
}
