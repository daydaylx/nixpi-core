/**
 * NixPi exposes no built-in coding tools (no bash/edit/write/read/...). The model only gets the
 * domain tools registered by the NixPi extension. The factory is never called, so not even an
 * explicit `--tools bash` can bring a shell back.
 */
export function nixpiBaseToolDefinitions<T>(_createAll: () => Record<string, T>): Record<string, T> {
	return {};
}
