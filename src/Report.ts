import type { Report } from "./Domain.js";

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export const junit = (report: Report): string => {
  const failures = report.cases.filter(
    (result) => result.status === "fail",
  ).length;
  const errors =
    report.cases.filter((result) => result.status.endsWith("error")).length +
    report.errors.length;
  const tests = report.cases.map((result) => {
    const problem =
      result.status === "pass"
        ? ""
        : `<${result.status === "fail" ? "failure" : "error"} message="${xml(result.status)}">${xml(result.error ?? "No observation")}</${result.status === "fail" ? "failure" : "error"}>`;
    return `  <testcase name="${xml(result.id)}" classname="celld-tck.${report.profile}" time="${result.durationMs / 1000}">${problem}</testcase>`;
  });
  report.errors.forEach((error, index) =>
    tests.push(
      `  <testcase name="harness.${index}"><error>${xml(error)}</error></testcase>`,
    ),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="celld-tck" tests="${tests.length}" failures="${failures}" errors="${errors}">\n${tests.join("\n")}\n</testsuite>\n`;
};
