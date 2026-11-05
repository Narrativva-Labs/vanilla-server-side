import { execFileSync } from "node:child_process";
/** Built once, before any test file runs, for tests that start the real server and scripts. */
export default function setup() {
  execFileSync("npm", ["run", "build"], { stdio: "pipe" });
}
