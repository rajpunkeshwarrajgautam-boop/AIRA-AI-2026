/**
 * Tier B revocation safety guard.
 *
 * Shared GitHub Actions credentials cannot revoke a status restricted to the
 * dedicated GitHub App expected source. This legacy CLI deliberately refuses
 * to publish a misleading github-actions[bot] failure context.
 * Owners must dispatch .github/workflows/release-authorization-revoke.yml
 * from the protected prod-release branch after GitHub App installation.
 */
console.error(
  '[REVOKE_RELEASE_AUTH] Tier B only: legacy GitHub-token revocation is disabled. ' +
  'Use GitHub Actions > Revoke Release Authorization via GitHub App (No Deployment) ' +
  'on prod-release with REVOKE <exact-current-PR-HEAD-SHA>.'
);
process.exitCode = 1;
