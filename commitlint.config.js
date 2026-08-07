module.exports = {
  extends: ['@commitlint/config-conventional']
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [0],
    'body-leading-blank': [0],
  },
  ignores: [
    // Skip specific historical commits with non-compliant messages
    (msg) => msg.startsWith('IssuerRegistry: on-chain issuer metadata'),
    // Skip bot-generated commits (e.g. greptile-apps[bot], dependabot)
    (msg) => /^\s*(?:Update\s+\.github\/|Bump\s+)/i.test(msg),
  ],
};
