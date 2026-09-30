// Child process for the ChangeStore concurrency test.
import { ChangeStore } from "../../../src/nixpi/history/store.ts";
const [dir, n, tag] = process.argv.slice(2);
const s = new ChangeStore(dir);
for (let i = 0; i < Number(n); i++) {
	const cs = s.create({ userIntent: `${tag}-${i}`, risk: "LOW" });
	s.update(cs.id, { status: "built" });
}
