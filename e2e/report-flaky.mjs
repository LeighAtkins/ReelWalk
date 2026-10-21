/* global process, console */
// Lists the tests that passed only on their retry (ADR 0054). CI retries a
// failed test once, and Playwright then counts the run as passed, so a test
// that fails every first attempt (ten-asks did, in 37 runs out of 37) stays
// invisible. This reads the JSON report and writes "flaky: <spec>" lines to
// the job summary, plus a warning annotation each, so they show on the PR.
//
//   node e2e/report-flaky.mjs e2e/test-results/results.json
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const file = process.argv[2] ?? "test-results/results.json";
const summary = process.env.GITHUB_STEP_SUMMARY;
const write = (text) => (summary ? appendFileSync(summary, text) : process.stdout.write(text));

if (!existsSync(file)) {
  write(`No Playwright report at ${file}, so flaky tests could not be listed.\n`);
  process.exit(0);
}

const report = JSON.parse(readFileSync(file, "utf8"));
const flaky = [];
const walk = (suite) => {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      if (test.status === "flaky") flaky.push({ file: spec.file, line: spec.line, title: spec.title, failures: test.results.filter((result) => result.status !== "passed" && result.status !== "skipped").length });
    }
  }
  for (const child of suite.suites ?? []) walk(child);
};
for (const suite of report.suites ?? []) walk(suite);

if (flaky.length === 0) {
  write("No flaky end-to-end tests: every test that passed, passed on its first attempt.\n");
} else {
  write(`### ${flaky.length} flaky end-to-end test${flaky.length === 1 ? "" : "s"} (passed only on retry)\n\n`);
  for (const test of flaky) {
    write(`- flaky: \`${test.file}:${test.line}\` ${test.title} (failed ${test.failures} time${test.failures === 1 ? "" : "s"} first)\n`);
    console.log(`::warning file=e2e/tests/${test.file},line=${test.line},title=Flaky test::${test.title} passed only on retry`);
  }
}
