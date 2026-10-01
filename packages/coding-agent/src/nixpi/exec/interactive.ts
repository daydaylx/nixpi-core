import { spawnSync } from "node:child_process";
import type { ExtensionContext } from "../../core/extensions/types.ts";

/**
 * Runs a fixed command with full terminal access (for the sudo password prompt). The TUI is
 * suspended while it runs. Non-TUI modes return undefined (caller must refuse to apply).
 */
export async function runWithTerminal(
	ctx: ExtensionContext,
	cmd: string,
	args: string[],
	cwd?: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<number | null | undefined> {
	if (ctx.mode !== "tui") return undefined;
	return ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		const res = spawnSync(cmd, args, { stdio: "inherit", cwd, env });
		tui.start();
		tui.requestRender(true);
		done(res.status);
		return { render: () => [], invalidate: () => {} };
	});
}
