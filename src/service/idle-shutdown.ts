export interface IdleShutdownPolicy {
	shouldClose(now: number, registeredClients: number, streamClients: number): boolean;
}

/** Keep a new daemon alive long enough for the spawning Pi to authenticate its first attachment. */
export function createIdleShutdownPolicy(idleMs: number, startupGraceMs: number, startedAt: number): IdleShutdownPolicy {
	let hasSeenClient = false;
	let idleSince: number | undefined;
	return {
		shouldClose(now, registeredClients, streamClients) {
			if (registeredClients > 0 || streamClients > 0) {
				hasSeenClient = true;
				idleSince = undefined;
				return false;
			}
			if (!hasSeenClient) return now - startedAt >= startupGraceMs;
			idleSince ??= now;
			return now - idleSince >= idleMs;
		},
	};
}
