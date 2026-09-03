/**
 * Conventional Commits (docs/conventions/GIT-WORKFLOW.md). Enforced by lefthook's
 * commit-msg hook and by CI-adjacent review.
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'build', 'ci', 'perf', 'revert'],
    ],
    'scope-case': [2, 'always', 'kebab-case'],
    'subject-case': [0], // allow "0.1 repo init" style subjects
    'body-max-line-length': [0], // verification blocks quote long command output
    'footer-max-line-length': [0],
  },
};
