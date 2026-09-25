export type AgentHost = {
  hostname: string;
  operatingSystem: string;
  kernel: string;
  architecture: string;
  uptimeSeconds: number;
  cpuCount: number;
  load1: number;
  temperatureC?: number;
};

export type AgentMetrics = {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  networkRxBytesPerSecond: number;
  networkTxBytesPerSecond: number;
  diskReadBytesPerSecond?: number;
  diskWriteBytesPerSecond?: number;
};

export type AgentFilesystem = {
  id: string;
  device: string;
  mount: string;
  mounts: string[];
  type: string;
  category: "local" | "network" | "removable" | "other";
  readOnly: boolean;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  reservedBytes: number;
  usedPercent: number;
  inodesTotal: number;
  inodesUsed: number;
  inodesUsedPercent: number;
};

export type StorageEntry = { path: string; sizeBytes: number; modified?: string };
export type StorageAnalysis = { mount: string; filesystemId: string; scannedAt: string; durationMillis: number; topDirectories: StorageEntry[]; topFiles: StorageEntry[]; entriesVisited: number; permissionErrors: number; crossMountsSkipped: number; truncated: boolean };
export type CleanupCandidate = { id: string; label: string; description: string; reclaimableBytes: number; risk: "low" | "medium" | "high"; action: string; available: boolean; detail?: string };

export type AgentService = { unit: string; description: string; load: string; active: string; sub: string; enabled: string };
export type FirewallRule = { index: number; to: string; action: string; from: string; raw: string };
export type Listener = { protocol: string; address: string; port: number; process?: string; pid?: number; scope: "loopback" | "all" | "interface" };
export type AgentSecurity = {
  collectedAt: string;
  firewall: { provider: string; installed: boolean; enabled: boolean; logging?: string; defaultIncoming?: string; defaultOutgoing?: string; defaultRouted?: string; rules: FirewallRule[]; error?: string };
  listeners: Listener[];
  ssh: { available: boolean; port?: string; listenAddress?: string; permitRootLogin?: string; passwordAuthentication?: string; pubkeyAuthentication?: string; permitEmptyPasswords?: string; x11Forwarding?: string; allowTcpForwarding?: string; error?: string };
  vpn: { provider: string; installed: boolean; connected: boolean; updateAvailable: boolean; autoConnect?: boolean; killSwitch?: boolean; server?: string; hostname?: string; ip?: string; country?: string; city?: string; technology?: string; protocol?: string; postQuantum?: string; received?: string; sent?: string; uptime?: string; defaultRouteInterface?: string; fields?: Record<string, string>; error?: string };
  automaticUpdates: { enabled: boolean; timerEnabled: boolean; timerActive: boolean; lastRun?: string };
};

export type AgentContainer = {
  id: string;
  name: string;
  image: string;
  state: "running" | "stopped" | "unhealthy";
  health: string;
  cpuPercent: number;
  memoryBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  ports: string[];
  createdAt: string;
  composeProject?: string;
  composeService?: string;
};

export type AgentLog = {
  timestamp: string;
  severity: "info" | "warning" | "error";
  source: string;
  message: string;
};

export type AgentUpdate = {
  package: string;
  currentVersion: string;
  candidateVersion: string;
  source: string;
  security: boolean;
};

export type AgentSnapshot = {
  schemaVersion: 1;
  collectedAt: string;
  host: AgentHost;
  metrics: AgentMetrics;
  filesystems: AgentFilesystem[];
  docker: {
    connected: boolean;
    version?: string;
    error?: string;
    containers: AgentContainer[];
  };
  logs: AgentLog[];
  updates: {
    checkedAt: string;
    available: number;
    security: number;
    error?: string;
    packages: AgentUpdate[];
  };
  services: AgentService[];
  security: AgentSecurity;
  warnings: string[];
};

export type DashboardApplicationMatch = {
  composeProjects?: string[];
  composeServices?: string[];
  containerNames?: string[];
};

export type DashboardApplicationConfig = {
  id: string;
  name: string;
  description?: string;
  color?: string;
  accent?: string;
  match: DashboardApplicationMatch;
};

export type DashboardConfig = {
  version: 1;
  host?: {
    displayName?: string;
  };
  applications: DashboardApplicationConfig[];
  containerAliases: Record<string, string>;
  settings?: {
    refreshIntervalSeconds?: number;
    elevationTimeoutSeconds?: number;
    managedServices?: string[];
  };
  savedLogViews?: Array<{
    id: string;
    name: string;
    level: "all" | "info" | "warning" | "error";
    query: string;
  }>;
};

export type SystemJob = {
  id: string;
  action: "refresh-repositories" | "install-updates" | "reboot" | "poweroff" | "cleanup-apt-cache" | "cleanup-journals-30d" | "cleanup-journals-1g" | "cleanup-tempfiles" | "docker-containers" | "docker-images" | "docker-build-cache";
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  error?: string;
  reclaimedBytes?: number;
};

export type ProviderEnvelope = {
  mode: "live" | "mock" | "unavailable";
  snapshot?: AgentSnapshot;
  configuration?: DashboardConfig;
  configurationError?: string;
  error?: string;
};
