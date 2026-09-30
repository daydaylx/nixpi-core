import { BUILTIN_PATH_PREFIX } from "../../core/source-info.ts";

/**
 * NixPi trust model: only built-in extensions run. Extensions from `-e`, settings, installed
 * packages or project directories are never loaded, so nothing can re-add a shell or widen the
 * tool boundary. (Skills, prompt templates and context files are disabled in main.ts.)
 */
export const onlyBuiltinExtensions = (paths: string[]): string[] =>
	paths.filter((p) => p.startsWith(BUILTIN_PATH_PREFIX));
