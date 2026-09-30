// Minimal fake MCP server over stdio (newline-delimited JSON-RPC) for tests.
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const msg = JSON.parse(line);
	if (msg.id === undefined) return;
	const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
	if (msg.method === "initialize") return reply({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "0" } });
	if (msg.method === "tools/call") {
		const a = msg.params.arguments;
		if (a.action === "search") return reply({ content: [{ type: "text", text: `hardware.bluetooth.enable (boolean): Whether to enable Bluetooth\nhardware.bluetooth.powerOnBoot: Power on at boot` }] });
		if (a.action === "info") return reply({ content: [{ type: "text", text: a.query === "hardware.bluetooth.enable" ? "Type: boolean\nVersion: 1.2\nWhether to enable Bluetooth" : "not found" }] });
	}
	reply({ content: [{ type: "text", text: "" }], isError: true });
});
