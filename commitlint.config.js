module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [0],
    'body-leading-blank': [0],
  },
  ignores: [
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
    // Skip Freebuff bot commits, whose subject is a generated file-change summary
    (msg) => /^\s*Update\s+\d+\s+files/i.test(msg) && /Freebuff Agent/i.test(msg),
  ],
};
