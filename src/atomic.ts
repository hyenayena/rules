import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {link, lstat, open, realpath, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import {RULES_FILE, statKey} from './engine.js';

// Writes the file through a temporary sibling. `expected` is the stat key the caller read (undefined = the file must not exist):
// when the file changed since, nothing is written.
async function writeOnce(file: string, text: string, mode: number, expected: string | undefined): Promise<void> {
	const tmp = path.join(path.dirname(file), `${RULES_FILE}.${randomBytes(6).toString('hex')}.tmp`);
	try {
		const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
		try {
			await handle.chmod(mode);
			await handle.writeFile(text);
			await handle.sync();
		} finally {
			await handle.close();
		}
		const now = await lstat(file).then(statKey, () => undefined);
		if (now !== expected) throw new Error('the file changed while it was being updated; try again');
		if (expected === undefined) await link(tmp, file);
		else await rename(tmp, file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('the file changed while it was being updated; try again');
		throw error;
	} finally {
		await unlink(tmp).catch(() => undefined);
	}
}

const chains = new Map<string, Promise<unknown>>();

// Writers in this process take turns per file; the stat compare still guards against other processes.
export async function lockedRulesWrite<T>(file: string, job: () => Promise<T>): Promise<T> {
	const key = path.join(await realpath(path.dirname(file)).catch(() => path.dirname(file)), path.basename(file));
	const run = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(job);
	chains.set(key, run);
	try {
		return await run;
	} finally {
		if (chains.get(key) === run) chains.delete(key);
	}
}

export const writeRulesAtomic = writeOnce;
