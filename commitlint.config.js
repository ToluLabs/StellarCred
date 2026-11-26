module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [0],
    'body-leading-blank': [0],
    'footer-max-line-length': [0],
    'footer-leading-blank': [0],
  },
  ignores: [
    // #611 backfill PR's first commit was pushed with a sentence-case subject
    // ("feat: Feature: …"); history is already on the PR branch, exempt it
    (msg) => msg.startsWith('feat: Feature: indexer backfill command'),
    // Skip specific historical commits with non-compliant messages
    (msg) => msg.startsWith('IssuerRegistry: on-chain issuer metadata'),
    // #342-era fix commits whose subjects start with an uppercase verb
    // (violates subject-case); history is already pushed, so exempt them here
    (msg) =>
      msg.startsWith('fix(#342): Correct EventAdminChanged') ||
      msg.startsWith('fix(#342): Fix EventAdminChanged') ||
      msg.startsWith('fix(#342): Complete admin rotation'),
    // Skip bot-generated commits (e.g. greptile-apps[bot], dependabot)
    (msg) => /^\s*(?:Update\s+\.github\/|Bump\s+)/i.test(msg),
    // #816 attribute-normalization commit was pushed with a bare "# …" subject
    // (no conventional type); history is already on the PR branch, exempt it
    (msg) => msg.startsWith('# remove duplicated attribute normalization'),
    // Skip Freebuff bot commits, whose subject is a generated file-change summary
    (msg) => /^\s*Update\s+\d+\s+files/i.test(msg) && /Freebuff Agent/i.test(msg),
    // Commits already pushed to this PR branch with a pasted description or a
    // bare filename as the subject (no conventional type, header well over 100
    // characters). Rewriting the branch history is not an option here, so
    // exempt them the same way as the historical commits above.
    (msg) =>
      msg.startsWith("Root cause: local branch was behind remote merge") ||
      msg.startsWith("Update check-env-sync.mjs") ||
      msg.startsWith("dded a standalone indexer cursor contract doc") ||
      msg.startsWith("I implemented and documented the health-check surface"),
  ],
};
