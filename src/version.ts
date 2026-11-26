/**
 * The engine's own version, kept in step with the root `package.json`.
 *
 * It is deliberately separate from `CONTRACT_VERSION`: the server can ship a
 * patch without changing the wire, and a contract can change without renaming
 * the deployment. `tests/contract/handshake.test.ts` fails when this drifts from
 * `package.json`.
 */
export const ENGINE_VERSION = '0.1.0';
export const ENGINE_NAME = 'coderax-workflow-engine';
