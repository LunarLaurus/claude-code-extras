// Preloaded with `node --import` so the reference script, the standalone entry and the daemon all read the same
// scripted clock. The test harness rewrites the file named by FAKE_NOW_FILE before each event.
import { readFileSync } from "node:fs";

const clockFile = process.env.FAKE_NOW_FILE;
if (clockFile) {
  Date.now = () => Number(readFileSync(clockFile, "utf8"));
}
