import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readFileSync, removeDirSync } from "@cloudflare/workers-utils";

interface LockInfo {
	pid: number;
	timestamp: number;
}

/**
 * Maximum age (in ms) before a lock is considered stale. Set generously —
 * a healthy refresh spans one network round-trip (~500 ms), but a slow
 * connection or a debugger-paused process could take longer.
 */
const STALE_THRESHOLD_MS = 30_000;

/** How many times to retry lock acquisition before giving up. */
const MAX_RETRIES = 5;

/** Delay (ms) between retry attempts. */
const RETRY_DELAY_MS = 200;

/**
 * Name of the file written inside the lock directory to record the
 * owning process.
 */
const LOCK_INFO_FILE = "info.json";

/**
 * @param ms - The number of milliseconds to sleep.
 * @returns A promise that resolves after the given delay.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the lock-info file inside an existing lock directory.
 *
 * @param lockDir - Path to the lock directory.
 * @returns The parsed lock info, or `undefined` if the file is missing/corrupt.
 */
function readLockInfo(lockDir: string): LockInfo | undefined {
	const infoPath = path.join(lockDir, LOCK_INFO_FILE);
	try {
		const raw = readFileSync(infoPath);
		return JSON.parse(raw) as LockInfo;
	} catch {
		return undefined;
	}
}

/**
 * Write the lock-info file into an already-created lock directory.
 *
 * @param lockDir - Path to the lock directory.
 */
function writeLockInfo(lockDir: string): void {
	const info: LockInfo = { pid: process.pid, timestamp: Date.now() };
	writeFileSync(
		path.join(lockDir, LOCK_INFO_FILE),
		JSON.stringify(info),
		"utf-8"
	);
}

/**
 * Check whether a given PID corresponds to a running process.
 *
 * @param pid - The process ID to check.
 * @returns `true` if the process is alive, `false` otherwise.
 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Determine whether an existing lock is stale (owning process is dead or
 * the lock has aged past {@link STALE_THRESHOLD_MS}).
 *
 * @param lockDir - Path to the lock directory.
 * @returns `true` if the lock should be broken, `false` if it is still valid.
 */
function isLockStale(lockDir: string): boolean {
	const info = readLockInfo(lockDir);
	if (!info) {
		return true;
	}
	if (!isProcessAlive(info.pid)) {
		return true;
	}
	return Date.now() - info.timestamp > STALE_THRESHOLD_MS;
}

/**
 * Forcibly remove a stale lock directory.
 *
 * @param lockDir - Path to the lock directory to break.
 */
function breakLock(lockDir: string): void {
	removeDirSync(lockDir);
}

/**
 * Try to acquire the advisory lock once.
 *
 * @param lockDir - Path to the lock directory.
 * @returns `true` if the lock was acquired, `false` if it is held by another process.
 */
function tryAcquire(lockDir: string): boolean {
	try {
		mkdirSync(lockDir);
		writeLockInfo(lockDir);
		return true;
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") {
			if (isLockStale(lockDir)) {
				breakLock(lockDir);
				try {
					mkdirSync(lockDir);
					writeLockInfo(lockDir);
					return true;
				} catch {
					return false;
				}
			}
			return false;
		}
		throw e;
	}
}

/**
 * Release the advisory lock by removing the lock directory.
 *
 * @param lockDir - Path to the lock directory.
 */
function releaseLock(lockDir: string): void {
	removeDirSync(lockDir);
}

/**
 * Acquire an advisory file lock, execute `fn`, and release the lock.
 *
 * The lock serializes the OAuth token refresh across sibling wrangler
 * processes on the same machine. If the lock cannot be acquired after
 * {@link MAX_RETRIES} attempts (e.g. a sibling is legitimately mid-refresh),
 * `fn` is executed without the lock — the retry-on-`invalid_grant` logic in
 * the caller provides a safety net.
 *
 * @param lockDir - Path to use as the lock directory (e.g. `storage.path() + '.refresh-lock'`).
 * @param fn - The async function to execute while holding the lock.
 * @returns The return value of `fn`.
 */
export async function withRefreshLock<T>(
	lockDir: string,
	fn: () => Promise<T>
): Promise<T> {
	let acquired = false;
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		if (tryAcquire(lockDir)) {
			acquired = true;
			break;
		}
		await sleep(RETRY_DELAY_MS);
	}

	try {
		return await fn();
	} finally {
		if (acquired) {
			releaseLock(lockDir);
		}
	}
}

/**
 * Visible for testing only — the constants governing lock behaviour.
 */
export const _TEST_CONSTANTS = {
	STALE_THRESHOLD_MS,
	MAX_RETRIES,
	RETRY_DELAY_MS,
	LOCK_INFO_FILE,
} as const;
