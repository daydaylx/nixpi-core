import type { InlineExtension } from "../core/extensions/types.ts";
import nixpiExtension from "../nixpi/extension.ts";

// NixPi: only the NixPi extension is built in. Pi's llama.cpp, codemode, tool-search and generic MCP
// extensions are intentionally not loaded (codemode/MCP would bypass the NixPi tool boundary).
export const builtInExtensions: InlineExtension[] = [{ name: "nixpi", factory: nixpiExtension, builtin: true }];
