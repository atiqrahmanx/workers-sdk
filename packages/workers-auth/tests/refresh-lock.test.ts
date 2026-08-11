import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runInTempDir } from "@cloudflare/workers-utils/test-helpers";
import { describe, it } from "vitest";
import { withRefreshLock, _TEST_CONSTANTS } from "../src/refresh-lock";

describe("withRefreshLock", () => {
	runInTempDir();

	function lockDir(): string {
		return path.join(process.cwd(), "test.lock");
	}

	it("acquires and releases the lock around fn", async ({ expect }) => {
		const result = await withRefreshLock(lockDir(), async () => {
			expect(existsSync(lockDir())).toBe(true);
			return 42;
		});
		expect(result).toBe(42);
		expect(existsSync(lockDir())).toBe(false);
	});

	it("releases the lock when fn throws", async ({ expect }) => {
		await expect(
			withRefreshLock(lockDir(), async () => {
				throw new Error("boom");
			})
		).rejects.toThrow("boom");
		expect(existsSync(lockDir())).toBe(false);
	});

	it("breaks a stale lock held by a dead process", async ({ expect }) => {
		const dir = lockDir();
		mkdirSync(dir);
		writeFileSync(
			path.join(dir, _TEST_CONSTANTS.LOCK_INFO_FILE),
			JSON.stringify({ pid: 999999999, timestamp: Date.now() }),
			"utf-8"
		);

		const result = await withRefreshLock(dir, async () => "acquired");
		expect(result).toBe("acquired");
		expect(existsSync(dir)).toBe(false);
	});

	it("breaks a lock that has aged past the stale threshold", async ({
		expect,
	}) => {
		const dir = lockDir();
		mkdirSync(dir);
		writeFileSync(
			path.join(dir, _TEST_CONSTANTS.LOCK_INFO_FILE),
			JSON.stringify({
				pid: process.pid,
				timestamp: Date.now() - _TEST_CONSTANTS.STALE_THRESHOLD_MS - 1000,
			}),
			"utf-8"
		);

		const result = await withRefreshLock(dir, async () => "acquired");
		expect(result).toBe("acquired");
	});

	it("proceeds without the lock when acquisition fails after retries", async ({
		expect,
	}) => {
		const dir = lockDir();
		mkdirSync(dir);
		// Lock held by the current process with a fresh timestamp — not stale,
		// so all retry attempts will fail.
		writeFileSync(
			path.join(dir, _TEST_CONSTANTS.LOCK_INFO_FILE),
			JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
			"utf-8"
		);

		const result = await withRefreshLock(dir, async () => "ran-unlocked");
		expect(result).toBe("ran-unlocked");
	});

	it("serializes two sequential callers on the same lock", async ({
		expect,
	}) => {
		const order: string[] = [];
		await withRefreshLock(lockDir(), async () => {
			order.push("first");
		});
		await withRefreshLock(lockDir(), async () => {
			order.push("second");
		});
		expect(order).toEqual(["first", "second"]);
	});

	it("breaks a lock directory with no info file", async ({ expect }) => {
		const dir = lockDir();
		mkdirSync(dir);
		// No info file written — readLockInfo returns undefined → stale.

		const result = await withRefreshLock(dir, async () => "acquired");
		expect(result).toBe("acquired");
	});
});
