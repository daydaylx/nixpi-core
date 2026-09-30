#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";
import { runNixpiCli } from "./nixpi/cli.ts";

setupCli();
const args = process.argv.slice(2);
// NixPi subcommands (recover, bootstrap, version) run without any LLM/provider.
runNixpiCli(args).then((handled) => {
	if (!handled) void main(args);
});
