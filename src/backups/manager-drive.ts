/**
 * The two pieces a store needs to manage several backups on Drive, behind one
 * import: the manager and the port over the destination.
 *
 * Their own modules stay the public API - this exists so `store.backups()` can
 * pull both in a single dynamic import, and so an app that never asks for a
 * backups list does not carry either of them.
 */

export { createBackupsManager } from './manager';
export { driveBackupsHost } from './drive-host';
