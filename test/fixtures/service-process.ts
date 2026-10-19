import { connectFlowService } from "../../src/service/client.ts";

async function main(): Promise<void> {
	const [agentDir, cwd, sessionId] = process.argv.slice(2);
	if (!agentDir || !cwd || !sessionId) throw new Error("Expected agentDir, cwd, and sessionId arguments");
	let finishInput!: () => void;
	const inputEnded = new Promise<void>((resolve) => { finishInput = resolve; });
	process.stdin.once("end", finishInput);
	process.stdin.resume();

	const connection = await connectFlowService({ agentDir, cwd, sessionId, port: 0 });
	process.stdout.write(`${JSON.stringify({ type: "connected", pid: process.pid, sessionId, url: connection.url, workspaceId: connection.workspaceId })}\n`);
	await inputEnded;
	await connection.close();
	process.stdout.write(`${JSON.stringify({ type: "closed", pid: process.pid, sessionId })}\n`);
}

main().catch((error: unknown) => {
	process.stderr.write(`service process fixture failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
