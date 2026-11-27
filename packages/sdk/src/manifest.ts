import { CONTRACT_VERSION, EVENT_SCHEMA_VERSION, SDK_VERSION } from '@coderax/contracts';

/**
 * One SDK method per published operation.
 *
 * The coverage test compares this table with the contract route catalogue and
 * with the methods that actually exist on the client, so an operation the engine
 * publishes cannot be missing from the shared client, and the client cannot claim
 * a method for an operation that is not published.
 */
export const SDK_COVERAGE: Readonly<Record<string, string>> = Object.freeze({
  getHealth: 'health',
  getReadiness: 'readiness',
  getHandshake: 'handshake',
  listAgents: 'agents',
  listModels: 'models',
  submitChat: 'chat',
  submitWork: 'submitWork',
  getTask: 'task',
  listTasks: 'tasks',
  cancelTask: 'cancel',
  resumeTask: 'resume',
  retryTask: 'retry',
  streamTaskEvents: 'events',
  listConversations: 'conversations',
  getConversation: 'conversation',
  listMemory: 'memory',
  putMemory: 'putMemory',
  listPermissions: 'permissions',
  listPendingPermissions: 'pendingPermissions',
  decidePermission: 'decidePermission',
  listNotifications: 'notifications',
  markNotificationsRead: 'markNotificationsRead',
  getMediaCapabilities: 'mediaCapabilities',
  uploadMedia: 'uploadMedia',
  getMedia: 'media',
  validateCreative: 'validateCreative',
  listSchedules: 'schedules',
  createSchedule: 'createSchedule',
  getSchedule: 'schedule',
  cancelSchedule: 'cancelSchedule',
  listArtifacts: 'artifacts',
  uploadArtifact: 'uploadArtifact',
  pruneArtifacts: 'pruneArtifacts',
  getArtifact: 'artifact',
  uploadArtifactVersion: 'uploadArtifactVersion',
  listArtifactVersions: 'artifactVersions',
  downloadArtifact: 'downloadArtifact',
  exportArtifact: 'exportArtifact',
  deleteArtifact: 'deleteArtifact',
});

/** Streaming methods that are an alternate transport for a covered operation. */
export const SDK_STREAM_METHODS: Readonly<Record<string, string>> = Object.freeze({
  submitChat: 'chatStream',
  streamTaskEvents: 'openEvents',
});

export const SDK_MANIFEST = Object.freeze({
  sdkVersion: SDK_VERSION,
  contractVersion: CONTRACT_VERSION,
  eventSchemaVersion: EVENT_SCHEMA_VERSION,
  operations: Object.keys(SDK_COVERAGE),
  streams: Object.keys(SDK_STREAM_METHODS),
});
