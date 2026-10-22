import { proxyRequest } from '../server/worker-proxy.js';
import { isMigrationBridgeRequest, migrateWorkspace } from '../server/workspace-migration.js';

// Web-standard handlers preserve multipart uploads and streamed PDF responses.
export default { fetch: request => isMigrationBridgeRequest(request) ? migrateWorkspace(request) : proxyRequest(request) };
