/** Public workspace navigation data. Never include filesystem paths or service-control secrets. */
export interface WorkspaceSummary {
  id: string;
  label: string;
  activeSessions: number;
  lastSeenAt: number;
}

export interface WorkspaceCatalog {
  workspaces: WorkspaceSummary[];
  defaultWorkspaceId?: string;
}

/** Private local control-plane registration; never project this object into browser responses. */
export interface WorkspaceRegistration {
  clientId: string;
  sessionId: string;
  pid: number;
  workspaceId: string;
  cwd: string;
  label: string;
}

export interface SharedServiceDescriptor {
  protocol: 1;
  serviceId: string;
  pid: number;
  url: string;
  controlToken: string;
  startedAt: number;
}

export const SHARED_SERVICE_PROTOCOL = 1 as const;
export const CONTROL_TOKEN_HEADER = "x-pi-flow-control";
export const SERVICE_DIRECTORY = "persona-flow/service-v1";
export const SERVICE_DESCRIPTOR_FILE = "service.json";
export const SERVICE_START_LOCK_FILE = "startup.lock";
