/** GitHub's GITHUB_SHA identifies the dispatching main commit. A pinned checkout
 * may intentionally differ; only the actual checkout can identify executing code. */
export function resolveEodRunnerCodeRevision(input: {
  actualRevision: string; productionRevision?: string; codeRevision?: string; githubSha?: string;
}): string {
  const actual = input.actualRevision.trim(), pin = input.productionRevision?.trim(), declared = input.codeRevision?.trim();
  const expected = pin || declared || input.githubSha?.trim() || actual;
  if (!/^[a-f0-9]{40}$/.test(actual) || !/^[a-f0-9]{40}$/.test(expected) || actual !== expected
    || (declared && declared !== actual)) throw new Error("eod-runner-code-revision-mismatch");
  return actual;
}
