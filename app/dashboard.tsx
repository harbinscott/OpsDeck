"use client";

import { useEffect, useMemo, useState } from "react";
import type { AgentFilesystem, AgentLog, AgentSnapshot, AgentUpdate, DashboardApplicationConfig, DashboardConfig, ProviderEnvelope, SystemJob } from "./lib/snapshot";
import { SecurityPage, ServicesPage, StoragePage as EnhancedStoragePage } from "./operations-pages";

type PageId = "overview" | "applications" | "containers" | "services" | "storage" | "logs" | "updates" | "security" | "settings";
type ContainerState = "running" | "stopped" | "unhealthy";
type ElevationState = { token: string; expiresAt: number; username: string };

type Container = {
  id: string;
  name: string;
  runtimeName?: string;
  application: string;
  image: string;
  state: ContainerState;
  health: string;
  cpu: number;
  memory: number;
  memoryText: string;
  network: string;
  ports: string;
  uptime: string;
  composeProject?: string;
  composeService?: string;
};

type ApplicationDefinition = {
  name: string;
  description: string;
  color: string;
  accent: string;
};

const mockContainers: Container[] = [
  { id: "c5a90e2e0262", name: "web_postgres", application: "Web platform", image: "postgres:16-alpine", state: "running", health: "Healthy", cpu: 0.1, memory: 119.7, memoryText: "119.7 MB", network: "18.1 MB / 264 MB", ports: "5432/tcp", uptime: "28 days" },
  { id: "775f06e61576", name: "web_api", application: "Web platform", image: "ghcr.io/example/api:2.4.1", state: "running", health: "Healthy", cpu: 0.2, memory: 58.1, memoryText: "58.1 MB", network: "69.2 MB / 60.7 MB", ports: "3001:3000", uptime: "28 days" },
  { id: "f138f0814161", name: "web_frontend", application: "Web platform", image: "ghcr.io/example/ui:2.4.1", state: "running", health: "Healthy", cpu: 0.0, memory: 39.7, memoryText: "39.7 MB", network: "427 KB / 963 KB", ports: "8088:80", uptime: "28 days" },
  { id: "4e82acb61b72", name: "notify-bot", application: "Integrations", image: "notify-bot:latest", state: "stopped", health: "Stopped", cpu: 0, memory: 0, memoryText: "—", network: "37 MB / 9.5 MB", ports: "—", uptime: "Stopped 3h ago" },
  { id: "af3edac60acf", name: "prometheus", application: "Monitoring", image: "prom/prometheus:latest", state: "running", health: "Healthy", cpu: 0.2, memory: 211.1, memoryText: "211.1 MB", network: "371 MB / 153 MB", ports: "9090:9090", uptime: "14 days" },
  { id: "667b4e7acccd", name: "grafana", application: "Monitoring", image: "grafana/grafana:latest", state: "running", health: "Healthy", cpu: 0.1, memory: 173.5, memoryText: "173.5 MB", network: "2.84 GB / 190 MB", ports: "3002:3000", uptime: "14 days" },
  { id: "f88d357ace5f", name: "report-worker", application: "Background jobs", image: "ghcr.io/example/worker:1.8.0", state: "unhealthy", health: "Health check failing", cpu: 26.4, memory: 27690, memoryText: "27.7 GB", network: "246 GB / 359 GB", ports: "8080:8080", uptime: "9 days" },
  { id: "542beb198987", name: "redis", application: "Background jobs", image: "redis:7-alpine", state: "running", health: "Healthy", cpu: 0.1, memory: 399.2, memoryText: "399.2 MB", network: "1.48 GB / 133 MB", ports: "6379/tcp", uptime: "9 days" },
  { id: "3aebd384a9f9", name: "node-exporter", application: "Monitoring", image: "prom/node-exporter:latest", state: "running", health: "Healthy", cpu: 0.1, memory: 162.1, memoryText: "162.1 MB", network: "508 MB / 3.53 GB", ports: "9100:9100", uptime: "14 days" },
  { id: "f3aa5b253009", name: "loki", application: "Monitoring", image: "grafana/loki:latest", state: "running", health: "Healthy", cpu: 0.1, memory: 984, memoryText: "984 MB", network: "1.65 GB / 325 MB", ports: "3100:3100", uptime: "14 days" },
  { id: "7a02708cc97c", name: "backup-scheduler", application: "Background jobs", image: "ghcr.io/example/backup:latest", state: "running", health: "Healthy", cpu: 0, memory: 44.4, memoryText: "44.4 MB", network: "91.2 MB / 417 KB", ports: "—", uptime: "14 days" },
];

const mockApplications: ApplicationDefinition[] = [
  { name: "Monitoring", description: "Metrics, dashboards, and log aggregation", color: "#7c6cf2", accent: "MO" },
  { name: "Web platform", description: "Customer-facing web application and API", color: "#2f9fd8", accent: "WP" },
  { name: "Background jobs", description: "Workers, queues, and scheduled tasks", color: "#e8a34a", accent: "BJ" },
  { name: "Integrations", description: "Bots and third-party integrations", color: "#42b883", accent: "IN" },
];

const applicationColors = ["#7c6cf2", "#2f9fd8", "#e8a34a", "#42b883", "#df6f9f", "#56b5a6"];

function formatBytes(bytes: number, precision = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : precision)} ${units[index]}`;
}

function formatRate(bytesPerSecond: number) {
  const bits = bytesPerSecond * 8;
  if (bits >= 1_000_000_000) return `${(bits / 1_000_000_000).toFixed(1)} Gb/s`;
  if (bits >= 1_000_000) return `${(bits / 1_000_000).toFixed(1)} Mb/s`;
  if (bits >= 1_000) return `${(bits / 1_000).toFixed(1)} Kb/s`;
  return `${bits.toFixed(0)} b/s`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unknown";
  const days = Math.floor(seconds / 86400);
  if (days > 0) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const minutes = Math.max(1, Math.floor(seconds / 60));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function exactMatch(values: string[] | undefined, value: string | undefined) {
  if (!value || !values?.length) return false;
  const candidate = value.toLocaleLowerCase();
  return values.some((item) => item.toLocaleLowerCase() === candidate);
}

function configuredApplication(container: AgentSnapshot["docker"]["containers"][number], applications: DashboardApplicationConfig[]) {
  return applications.find((application) =>
    exactMatch(application.match.composeProjects, container.composeProject) ||
    exactMatch(application.match.composeServices, container.composeService) ||
    exactMatch(application.match.containerNames, container.name));
}

function mapLiveContainers(snapshot?: AgentSnapshot, configuration?: DashboardConfig): Container[] {
  if (!snapshot) return mockContainers;
  return snapshot.docker.containers.map((container) => {
    const application = configuredApplication(container, configuration?.applications ?? []);
    const createdAt = Date.parse(container.createdAt);
    const uptimeSeconds = container.state === "stopped" || !Number.isFinite(createdAt)
      ? 0
      : Math.max(0, (Date.now() - createdAt) / 1000);
    return {
      id: container.id,
      name: configuration?.containerAliases[container.name] ?? container.name,
      runtimeName: container.name,
      application: application?.name || container.composeProject || "Ungrouped",
      image: container.image,
      state: container.state,
      health: container.health,
      cpu: container.cpuPercent,
      memory: container.memoryBytes / 1024 / 1024,
      memoryText: container.memoryBytes ? formatBytes(container.memoryBytes) : "—",
      network: `${formatBytes(container.networkRxBytes)} / ${formatBytes(container.networkTxBytes)}`,
      ports: container.ports.length ? container.ports.join(", ") : "—",
      uptime: container.state === "stopped" ? "Stopped" : formatDuration(uptimeSeconds),
      composeProject: container.composeProject,
      composeService: container.composeService,
    };
  });
}

function applicationDefinitions(containers: Container[], configuration?: DashboardConfig): ApplicationDefinition[] {
  const names = [...new Set([...containers.map((container) => container.application), ...(configuration?.applications.map((application) => application.name) ?? [])])];
  return names.map((name, index) => {
    const configured = configuration?.applications.find((application) => application.name === name);
    if (configured) {
      const accent = configured.accent || name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "AP";
      return { name, description: configured.description || "Configured application group", color: configured.color || applicationColors[index % applicationColors.length], accent };
    }
    const known = mockApplications.find((application) => application.name === name);
    if (known) return known;
    const accent = name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "AP";
    return { name, description: name === "Ungrouped" ? "Containers without application metadata" : "Discovered from Docker Compose labels", color: applicationColors[index % applicationColors.length], accent };
  });
}

function mapFilesystems(filesystems?: AgentFilesystem[]) {
  if (!filesystems) return undefined;
  const tones = ["purple", "blue", "green", "orange"];
  return filesystems.map((filesystem, index) => ({
    name: filesystem.mount === "/" ? "System" : filesystem.mount.split("/").filter(Boolean).at(-1) || filesystem.device,
    device: filesystem.device,
    mount: filesystem.mount,
    type: filesystem.type,
    used: formatBytes(filesystem.usedBytes),
    total: formatBytes(filesystem.totalBytes),
    percent: filesystem.usedPercent,
    tone: tones[index % tones.length],
  }));
}

const navSections = [
  { label: "Workspace", items: [{ id: "overview", label: "Overview", icon: "⌂" }, { id: "applications", label: "Applications", icon: "▦" }, { id: "containers", label: "Containers", icon: "▤" }] },
  { label: "System", items: [{ id: "services", label: "Services", icon: "S" }, { id: "storage", label: "Storage", icon: "◫" }, { id: "logs", label: "Logs & alerts", icon: "≡", badge: "2" }, { id: "updates", label: "Updates", icon: "↥", badge: "12" }, { id: "security", label: "Security", icon: "◆" }] },
  { label: "Manage", items: [{ id: "settings", label: "Settings", icon: "⚙" }] },
] as const;

const metricSeries = {
  cpu: [12, 18, 15, 24, 20, 34, 28, 31, 23, 38, 26, 30, 25, 29, 22, 17],
  memory: [58, 59, 59, 60, 60, 61, 62, 62, 62, 63, 63, 62, 63, 64, 64, 64],
  network: [18, 24, 15, 31, 27, 48, 34, 42, 29, 55, 41, 38, 62, 48, 39, 51],
  diskRead: Array(16).fill(0) as number[],
  diskWrite: Array(16).fill(0) as number[],
};

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1, ...values);
  return (
    <div className="sparkline" aria-hidden="true">
      {values.map((value, index) => (
        <span key={index} style={{ height: `${Math.max(10, (value / max) * 100)}%`, backgroundColor: color, opacity: 0.42 + index / values.length / 2 }} />
      ))}
    </div>
  );
}

function StatusDot({ state }: { state: ContainerState | "healthy" | "warning" }) {
  return <span className={`status-dot ${state}`} aria-hidden="true" />;
}

function PageHeader({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: React.ReactNode }) {
  return (
    <div className="page-heading">
      <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

function MetricCard({ label, value, detail, values, color, note }: { label: string; value: string; detail: string; values: number[]; color: string; note: string }) {
  return (
    <article className="metric-card card">
      <div className="metric-top"><span>{label}</span><span className="live-label"><i /> Live</span></div>
      <div className="metric-value">{value}</div>
      <div className="metric-detail">{detail}</div>
      <Sparkline values={values} color={color} />
      <div className="metric-note">{note}<span>Last 15 min</span></div>
    </article>
  );
}

function Overview({ onNavigate, snapshot, providerMode, containers, applications, history, hostLabel }: { onNavigate: (page: PageId) => void; snapshot?: AgentSnapshot; providerMode: ProviderEnvelope["mode"]; containers: Container[]; applications: ApplicationDefinition[]; history: typeof metricSeries; hostLabel: string }) {
  const running = containers.filter((c) => c.state === "running").length;
  const unhealthy = containers.filter((c) => c.state === "unhealthy").length;
  const host = snapshot?.host;
  const metrics = snapshot?.metrics;
  const memoryPercent = metrics?.memoryTotalBytes ? metrics.memoryUsedBytes / metrics.memoryTotalBytes * 100 : 64;
  const filesystemTotal = snapshot?.filesystems.reduce((sum, filesystem) => sum + filesystem.totalBytes, 0) ?? 3.49 * 1024 ** 4;
  const filesystemUsed = snapshot?.filesystems.reduce((sum, filesystem) => sum + filesystem.usedBytes, 0) ?? 1.92 * 1024 ** 4;
  const filesystemPercent = filesystemTotal ? filesystemUsed / filesystemTotal * 100 : 0;
  const isLive = providerMode === "live";
  return (
    <>
      <PageHeader eyebrow="Host overview" title={hostLabel} description={`${host?.hostname ?? "server01"} is reporting normally.${unhealthy ? ` ${unhealthy} workload needs attention.` : ""}`}>
        <button className="button ghost" onClick={() => onNavigate("logs")}>View alerts <span className="button-badge">{Math.max(unhealthy, snapshot?.warnings.length ?? 0)}</span></button>
        <button className="button primary" onClick={() => onNavigate("containers")}>Browse containers</button>
      </PageHeader>

      <section className="health-strip card">
        <div className="health-main"><span className="health-icon"><StatusDot state={snapshot?.warnings.length ? "warning" : "healthy"} /></span><div><strong>{snapshot?.warnings.length ? `${snapshot.warnings.length} provider warning${snapshot.warnings.length === 1 ? "" : "s"}` : "All host checks passing"}</strong><span>{host?.hostname ?? "server01"} · {host?.operatingSystem ?? "Ubuntu 24.04.4 LTS"} · up {formatDuration(host?.uptimeSeconds ?? 31 * 86400)}</span></div></div>
        <div className="health-facts"><span><small>Load average</small><strong>{host?.load1.toFixed(2) ?? "0.84"}</strong></span><span><small>Temperature</small><strong>{host?.temperatureC != null ? `${host.temperatureC.toFixed(0)}°C` : "Unavailable"}</strong></span><span><small>Last checked</small><strong>{isLive ? "Just now" : "Mock sample"}</strong></span></div>
      </section>

      <section className="metric-grid">
        <MetricCard label="CPU usage" value={`${(metrics?.cpuPercent ?? 17).toFixed(0)}%`} detail={`${host?.cpuCount ?? 8} logical CPUs`} values={history.cpu} color="#4aa8e8" note={isLive ? "Current host sample" : "Peak 38%"} />
        <MetricCard label="Memory" value={`${memoryPercent.toFixed(0)}%`} detail={metrics ? `${formatBytes(metrics.memoryUsedBytes)} of ${formatBytes(metrics.memoryTotalBytes)}` : "40.1 of 62.6 GB"} values={history.memory} color="#7c6cf2" note={metrics ? `${formatBytes(Math.max(0, metrics.memoryTotalBytes - metrics.memoryUsedBytes))} available` : "22.5 GB available"} />
        <MetricCard label="Network" value={metrics ? formatRate(metrics.networkRxBytesPerSecond) : "51 Mb/s"} detail="Aggregate inbound" values={history.network} color="#39b883" note={metrics ? `${formatRate(metrics.networkTxBytesPerSecond)} outbound` : "12 Mb/s outbound"} />
        <article className="metric-card storage-metric card"><div className="metric-top"><span>Storage</span><span className="neutral-pill">{snapshot?.filesystems.length ?? 3} volumes</span></div><div className="metric-value">{filesystemPercent.toFixed(0)}%</div><div className="metric-detail">{formatBytes(filesystemUsed)} of {formatBytes(filesystemTotal)} used</div><div className="storage-ring-row"><div className="storage-ring" style={{ background: `conic-gradient(var(--blue) 0 ${filesystemPercent}%, var(--surface-3) ${filesystemPercent}%)` }}><span>{formatBytes(Math.max(0, filesystemTotal - filesystemUsed))}<small>free</small></span></div><div className="storage-legend">{(snapshot?.filesystems.slice(0, 3) ?? []).map((filesystem, index) => <span key={filesystem.mount}><i className={index === 1 ? "slow" : index === 2 ? "system" : "fast"} />{filesystem.mount}<b>{filesystem.usedPercent.toFixed(0)}%</b></span>)}{!snapshot && <><span><i className="fast" />Fast store <b>67%</b></span><span><i className="slow" />Slow store <b>48%</b></span><span><i className="system" />System <b>50%</b></span></>}</div></div></article>
      </section>

      <section className="overview-grid">
        <article className="card applications-summary">
          <div className="section-header"><div><span className="section-kicker">Docker</span><h2>Applications</h2></div><button className="text-button" onClick={() => onNavigate("applications")}>View all →</button></div>
          <div className="app-summary-stats"><span><strong>{applications.length}</strong><small>applications</small></span><span><strong>{running}</strong><small>running containers</small></span><span><strong className="warning-text">{unhealthy}</strong><small>needs attention</small></span></div>
          <div className="app-list">
            {applications.slice(0, 3).map((app) => {
              const members = containers.filter((c) => c.application === app.name);
              const alert = members.some((c) => c.state === "unhealthy");
              return <button className="app-row" key={app.name} onClick={() => onNavigate("applications")}><span className="app-mark" style={{ backgroundColor: `${app.color}20`, color: app.color }}>{app.accent}</span><span className="app-info"><strong>{app.name}</strong><small>{members.length} container{members.length !== 1 ? "s" : ""}</small></span><span className={`app-state ${alert ? "warning" : ""}`}><StatusDot state={alert ? "warning" : "healthy"} />{alert ? "Degraded" : "Healthy"}</span><span className="row-arrow">›</span></button>;
            })}
          </div>
        </article>

        <article className="card activity-card">
          <div className="section-header"><div><span className="section-kicker">System</span><h2>Recent activity</h2></div><button className="text-button" onClick={() => onNavigate("logs")}>Open logs →</button></div>
          <div className="timeline">{snapshot?.logs.slice(0, 4).map((log) => <div key={`${log.timestamp}-${log.source}`}><span className={`timeline-dot ${log.severity === "error" || log.severity === "warning" ? "warning" : "info"}`} /><p><strong>{log.message}</strong><small>{log.source} · {new Date(log.timestamp).toLocaleTimeString()}</small></p></div>) ?? <><div><span className="timeline-dot info" /><p><strong>Repository metadata refreshed</strong><small>APT · 18 minutes ago</small></p></div><div><span className="timeline-dot warning" /><p><strong>Health check failed</strong><small>report-worker · 42 minutes ago</small></p></div><div><span className="timeline-dot success" /><p><strong>Backup completed</strong><small>/backup · 2 hours ago</small></p></div><div><span className="timeline-dot muted" /><p><strong>SSH session closed</strong><small>admin from 192.0.2.25 · 4 hours ago</small></p></div></>}</div>
        </article>
      </section>

      <section className="card system-info-card">
        <div className="section-header"><div><span className="section-kicker">Inventory</span><h2>System information</h2></div><span className="readonly-caption">{isLive ? "Live agent" : "Mock provider"} · read only</span></div>
        <div className="info-grid"><span><small>Hostname</small><strong>{host?.hostname ?? "server01"}</strong></span><span><small>Operating system</small><strong>{host?.operatingSystem ?? "Ubuntu 24.04.4 LTS"}</strong></span><span><small>Kernel</small><strong>{host?.kernel ?? "6.8.0-63-generic"}</strong></span><span><small>CPU profile</small><strong>{host ? `${host.cpuCount} logical CPUs` : "Alienware Aurora R9"}</strong></span><span><small>Architecture</small><strong>{host?.architecture ?? "x86_64"}</strong></span><span><small>Docker Engine</small><strong>{snapshot?.docker.version ?? "27.5.1"}</strong></span></div>
      </section>
    </>
  );
}

function ApplicationsPage({ onSelect, onManage, onApplicationAction, containers, applications, elevated, busyApplication }: { onSelect: (container: Container) => void; onManage: () => void; onApplicationAction: (application: string, action: "stop" | "restart") => void; containers: Container[]; applications: ApplicationDefinition[]; elevated: boolean; busyApplication?: string }) {
  return (
    <>
      <PageHeader eyebrow="Docker" title="Applications" description="Logical groups built from Compose metadata and dashboard aliases.">
        <button className="button primary" onClick={onManage}>{elevated ? "Manage groups" : "Elevate to manage"}</button>
      </PageHeader>
      <div className="application-grid">
        {applications.map((app) => {
          const members = containers.filter((c) => c.application === app.name);
          const unhealthy = members.filter((c) => c.state === "unhealthy").length;
          const stopped = members.filter((c) => c.state === "stopped").length;
          const memory = members.reduce((sum, c) => sum + c.memory, 0);
          return <article className="card application-card" key={app.name}>
            <div className="application-title"><span className="app-mark large" style={{ backgroundColor: `${app.color}20`, color: app.color }}>{app.accent}</span><div><h2>{app.name}</h2><p>{app.description}</p></div><span className={`health-badge ${unhealthy || stopped ? "warning" : ""}`}><StatusDot state={unhealthy || stopped ? "warning" : "healthy"} />{unhealthy ? "Degraded" : stopped ? "Partially stopped" : "Healthy"}</span></div>
            <div className="application-metrics"><span><small>Containers</small><strong>{members.length}</strong></span><span><small>CPU</small><strong>{members.reduce((sum, c) => sum + c.cpu, 0).toFixed(1)}%</strong></span><span><small>Memory</small><strong>{memory > 1024 ? `${(memory / 1024).toFixed(1)} GB` : `${memory.toFixed(0)} MB`}</strong></span></div>
            <div className="member-list">{members.map((container) => <button key={container.id} onClick={() => onSelect(container)}><span><StatusDot state={container.state} /><strong>{container.name}</strong></span><small>{container.image}</small><b>{container.state === "stopped" ? "Stopped" : `${container.cpu.toFixed(1)}% CPU`}</b><span className="row-arrow">›</span></button>)}</div>
            <div className="application-footer"><span>Compose discovery with optional dashboard mapping</span><div><button disabled={!elevated || busyApplication === app.name || members.every((member) => member.state === "stopped")} onClick={() => onApplicationAction(app.name, "stop")}>{busyApplication === app.name ? "Working…" : "Stop all"}</button><button disabled={!elevated || busyApplication === app.name || members.every((member) => member.state === "stopped")} onClick={() => onApplicationAction(app.name, "restart")}>Restart all</button></div></div>
          </article>;
        })}
      </div>
    </>
  );
}

function ContainersPage({ onSelect, containers, dockerConnected }: { onSelect: (container: Container) => void; containers: Container[]; dockerConnected: boolean }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | ContainerState>("all");
  const filtered = useMemo(() => containers.filter((c) => (filter === "all" || c.state === filter) && `${c.name} ${c.image} ${c.application}`.toLowerCase().includes(query.toLowerCase())), [containers, query, filter]);
  return (
    <>
      <PageHeader eyebrow="Docker" title="Containers" description="Live utilization and runtime metadata across this host.">
        <span className="engine-chip"><StatusDot state={dockerConnected ? "healthy" : "warning"} /> Docker {dockerConnected ? "connected" : "unavailable"}</span>
      </PageHeader>
      <section className="container-stats">
        <div className="card"><span className="stat-icon running">↑</span><span><small>Running</small><strong>{containers.filter((container) => container.state === "running").length}</strong></span></div><div className="card"><span className="stat-icon stopped">■</span><span><small>Stopped</small><strong>{containers.filter((container) => container.state === "stopped").length}</strong></span></div><div className="card"><span className="stat-icon warning">!</span><span><small>Unhealthy</small><strong>{containers.filter((container) => container.state === "unhealthy").length}</strong></span></div><div className="card"><span className="stat-icon neutral">◈</span><span><small>Images</small><strong>{new Set(containers.map((container) => container.image)).size}</strong></span></div>
      </section>
      <section className="card table-card">
        <div className="table-tools"><label className="search-box"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search containers, images, applications…" aria-label="Search containers" /></label><div className="filter-pills">{(["all", "running", "stopped", "unhealthy"] as const).map((value) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div><span className="result-count">{filtered.length} results</span></div>
        <div className="container-table-wrap"><table className="container-table"><thead><tr><th>Container</th><th>Application</th><th>State</th><th>CPU</th><th>Memory</th><th>Network I/O</th><th>Uptime</th><th /></tr></thead><tbody>{filtered.map((container) => <tr key={container.id} onClick={() => onSelect(container)}><td><div className="container-name"><span className={`container-cube ${container.state}`}>◆</span><span><strong>{container.name}</strong><small>{container.image}</small></span></div></td><td><span className="table-app">{container.application}</span></td><td><span className={`state-label ${container.state}`}><StatusDot state={container.state} />{container.health}</span></td><td><strong>{container.cpu.toFixed(1)}%</strong><span className="mini-bar"><i style={{ width: `${Math.min(100, container.cpu * 3)}%` }} /></span></td><td><strong>{container.memoryText}</strong></td><td className="mono-cell">{container.network}</td><td>{container.uptime}</td><td><button className="more-button" aria-label={`View ${container.name}`}>›</button></td></tr>)}</tbody></table></div>
        {filtered.length === 0 && <div className="empty-state"><span>⌕</span><h3>No containers found</h3><p>Try a different name or status filter.</p></div>}
      </section>
    </>
  );
}

const mockVolumes = [
  { name: "Data", device: "/dev/sdb1", mount: "/data", type: "ext4", used: "327 GB", total: "490 GB", percent: 67, tone: "purple" },
  { name: "Backups", device: "/dev/sda1", mount: "/backup", type: "ext4", used: "472 GB", total: "980 GB", percent: 48, tone: "blue" },
  { name: "Home", device: "/dev/mapper/ubuntu--vg-lv--0", mount: "/home", type: "ext4", used: "874 GB", total: "1.90 TB", percent: 46, tone: "green" },
  { name: "System", device: "/dev/mapper/ubuntu--vg-ubuntu--lv", mount: "/", type: "ext4", used: "55 GB", total: "110 GB", percent: 50, tone: "orange" },
];

function StoragePage({ filesystems, metrics, history }: { filesystems?: AgentFilesystem[]; metrics?: AgentSnapshot["metrics"]; history: typeof metricSeries }) {
  const volumes = mapFilesystems(filesystems) ?? mockVolumes;
  const totalUsed = filesystems?.reduce((sum, filesystem) => sum + filesystem.usedBytes, 0);
  const readRate = metrics?.diskReadBytesPerSecond ?? 0;
  const writeRate = metrics?.diskWriteBytesPerSecond ?? 0;
  return <><PageHeader eyebrow="System" title="Storage" description="Filesystems, capacity, and aggregate physical-disk throughput." /><section className="storage-layout"><article className="card storage-chart-card"><div className="section-header"><div><span className="section-kicker">Capacity</span><h2>Filesystem usage</h2></div><span className="neutral-pill">{totalUsed != null ? `${formatBytes(totalUsed)} used` : "1.92 TB used"}</span></div><div className="volume-list">{volumes.map((volume) => <div className="volume-row" key={volume.mount}><span className={`volume-icon ${volume.tone}`}>▰</span><div className="volume-main"><div><strong>{volume.name}</strong><small>{volume.device} · {volume.type}</small></div><span className="mount-pill">{volume.mount}</span></div><div className="volume-usage"><div><span>{volume.used} of {volume.total}</span><strong>{volume.percent.toFixed(0)}%</strong></div><span className="capacity-bar"><i className={volume.tone} style={{ width: `${volume.percent}%` }} /></span></div></div>)}</div></article><aside className="card io-card"><span className="section-kicker">Physical disks</span><h2>Current throughput</h2><div className="io-value"><strong>{formatBytes(readRate)}</strong><span>/s read</span></div><Sparkline values={history.diskRead} color="#2f9fd8" /><div className="io-chart-labels"><span>150 seconds ago</span><span>now</span></div><div className="io-value secondary"><strong>{formatBytes(writeRate)}</strong><span>/s write</span></div><Sparkline values={history.diskWrite} color="#7c6cf2" /><div className="io-chart-labels"><span>150 seconds ago</span><span>now</span></div><p className="io-context">Aggregate rate from physical block devices, sampled every 10 seconds.</p></aside></section></>;
}

const mockLogs = [
  { time: "16:42:19", severity: "warning", source: "docker/report-worker", message: "Health check failed: HTTP probe returned status 503" },
  { time: "16:41:02", severity: "info", source: "systemd", message: "Finished apt repository metadata refresh" },
  { time: "16:38:44", severity: "info", source: "docker/prometheus", message: "Completed scrape cycle: 142 targets, 0 failures" },
  { time: "16:32:11", severity: "error", source: "udisksd", message: "Error initializing module iscsi: shared object file not found" },
  { time: "16:28:55", severity: "info", source: "sshd", message: "Accepted publickey for admin from 192.0.2.25" },
  { time: "16:16:30", severity: "info", source: "docker/web_api", message: "Request completed GET /health 200 in 4ms" },
  { time: "15:57:12", severity: "warning", source: "smartd", message: "Device /dev/sda temperature changed from 39 to 44 Celsius" },
];

type DisplayLog = { time: string; severity: string; source: string; message: string };

function LogsPage({ agentLogs, configuration, elevated, onSaveConfiguration, onElevate }: { agentLogs?: AgentLog[]; configuration?: DashboardConfig; elevated: boolean; onSaveConfiguration: (configuration: DashboardConfig) => Promise<void>; onElevate: () => void }) {
  const [level, setLevel] = useState<"all" | "info" | "warning" | "error">("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<DisplayLog | null>(null);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [savingView, setSavingView] = useState(false);
  const logs = agentLogs?.map((log) => ({ time: new Date(log.timestamp).toLocaleTimeString([], { hour12: false }), severity: log.severity, source: log.source, message: log.message })) ?? mockLogs;
  const normalizedQuery = query.trim().toLowerCase();
  const visible = logs.filter((log) => (level === "all" || log.severity === level) && (!normalizedQuery || `${log.source} ${log.message}`.toLowerCase().includes(normalizedQuery)));
  const alerts = logs.filter((log) => log.severity === "error" || log.severity === "warning").slice(0, 2);
  const saveCurrentView = async () => {
    if (!elevated) { onElevate(); return; }
    const name = window.prompt("Name this saved log view:", query || `${level[0].toUpperCase() + level.slice(1)} logs`)?.trim();
    if (!name) return;
    setSavingView(true);
    const view = { id: `view-${Date.now()}`, name, level, query };
    try { await onSaveConfiguration({ ...(configuration ?? { version: 1, applications: [], containerAliases: {} }), savedLogViews: [...(configuration?.savedLogViews ?? []), view] }); }
    catch (reason) { window.alert(reason instanceof Error ? reason.message : "The saved view could not be stored."); }
    finally { setSavingView(false); }
  };
  return <><PageHeader eyebrow="System" title="Logs & alerts" description="A unified view of journald and container events."><button className="button ghost" onClick={() => setViewsOpen((open) => !open)}>Saved views ({configuration?.savedLogViews?.length ?? 0})</button></PageHeader>{viewsOpen && <section className="card saved-views-panel"><div><strong>Saved log views</strong><span>Store frequently used severity and search filters.</span></div><div className="saved-view-actions">{configuration?.savedLogViews?.map((view) => <button key={view.id} onClick={() => { setLevel(view.level); setQuery(view.query); setViewsOpen(false); }}>{view.name}</button>)}<button className="save-view-button" onClick={saveCurrentView} disabled={savingView}>{savingView ? "Saving…" : "+ Save current view"}</button></div></section>}{alerts.length > 0 && <section className="alert-grid">{alerts.map((alert, index) => <article className={`card alert-item ${alert.severity === "warning" ? "warning" : "info"}`} key={`${alert.time}-${index}`}><span className="alert-symbol">!</span><div><span>{alert.source}</span><strong>{alert.message}</strong><small>Observed at {alert.time}</small></div><button onClick={() => setSelected(alert)}>Inspect</button></article>)}</section>}<section className="card log-card"><div className="table-tools"><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search messages or sources…" aria-label="Search logs" /></label><div className="filter-pills">{(["all", "info", "warning", "error"] as const).map((value) => <button key={value} className={level === value ? "active" : ""} onClick={() => setLevel(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div><span className="live-label"><i /> {agentLogs ? "Streaming" : "Sample"}</span></div><div className="log-list">{visible.map((log, index) => <div className="log-row" key={`${log.time}-${index}`}><span className="log-time">{log.time}</span><span className={`log-level ${log.severity}`}>{log.severity}</span><span className="log-source">{log.source}</span><p>{log.message}</p><button aria-label="Open log details" onClick={() => setSelected(log)}>›</button></div>)}</div></section>{selected && <div className="modal-backdrop" onMouseDown={() => setSelected(null)}><section className="modal-card log-detail" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Log event</span><h2>{selected.source}</h2></div><button className="close-button" onClick={() => setSelected(null)}>×</button></div><dl><div><dt>Time</dt><dd>{selected.time}</dd></div><div><dt>Severity</dt><dd className={`log-level ${selected.severity}`}>{selected.severity}</dd></div><div><dt>Source</dt><dd>{selected.source}</dd></div></dl><pre>{selected.message}</pre><div className="modal-actions"><button className="button primary" onClick={() => setSelected(null)}>Close</button></div></section></div>}</>;
}

function UpdatesPage({ updates, elevated, operation, onAction }: { updates?: AgentSnapshot["updates"]; elevated: boolean; operation: SystemJob | null; onAction: (action: SystemJob["action"]) => void }) {
  const mockPackages: AgentUpdate[] = [["libssl3t64", "3.0.13-0ubuntu3.5", "3.0.13-0ubuntu3.6", true], ["openssh-server", "1:9.6p1-3ubuntu13.11", "1:9.6p1-3ubuntu13.12", true], ["docker-ce", "5:27.5.0-1", "5:27.5.1-1", false], ["linux-generic-hwe-24.04", "6.8.0.62.65", "6.8.0.63.66", true], ["curl", "8.5.0-2ubuntu10.6", "8.5.0-2ubuntu10.7", false], ["ca-certificates", "20240203", "20240618", false]].map(([name, current, candidate, security]) => ({ package: String(name), currentVersion: String(current), candidateVersion: String(candidate), source: "Ubuntu", security: Boolean(security) }));
  const packages = updates?.packages ?? mockPackages;
  const available = updates?.available ?? 12;
  const security = updates?.security ?? 4;
  const busy = operation?.status === "running";
  return <><PageHeader eyebrow="System" title="Updates" description={`Package status from the ${updates ? "live" : "mocked"} APT provider.`}><span className="readonly-hint">{elevated ? "Administrative access active" : "Elevation required"}</span><button className="button ghost" disabled={busy} onClick={() => onAction("refresh-repositories")}>Refresh repositories</button><button className="button primary" disabled={busy || available === 0} onClick={() => onAction("install-updates")}>Install all updates</button></PageHeader>{operation && ["refresh-repositories", "install-updates"].includes(operation.action) && <div className={`operation-notice ${operation.status}`}><StatusDot state={operation.status === "failed" ? "warning" : "healthy"} /><span><strong>{operation.action === "refresh-repositories" ? "Repository refresh" : "Package installation"} {operation.status}</strong>{operation.error || (operation.status === "running" ? "The operation is continuing on the server." : "Package inventory will refresh automatically.")}</span></div>}<section className="update-hero card"><div className="update-icon">↥</div><div><span className="section-kicker">{updates ? `Checked ${new Date(updates.checkedAt).toLocaleTimeString()}` : "Last checked 18 minutes ago"}</span><h2>{available} package updates available</h2><p>{security} security updates and {Math.max(0, available - security)} standard updates. Installation uses APT&apos;s non-interactive standard upgrade.</p></div><div className="update-count"><strong>{available}</strong><span>updates</span></div></section><section className="card update-list-card"><div className="section-header"><div><span className="section-kicker">APT packages</span><h2>Available changes</h2></div><span className="download-size">Refresh metadata before installing updates</span></div><div className="package-list">{packages.slice(0, 12).map((pkg) => <div className="package-row" key={pkg.package}><span className="package-icon">▣</span><div><strong>{pkg.package}</strong><small>{pkg.currentVersion || "Installed"} <b>→</b> {pkg.candidateVersion}</small></div><span className={`package-type ${pkg.security ? "security" : "standard"}`}>{pkg.security ? "Security" : "Standard"}</span><button onClick={() => window.alert(`${pkg.package}\nInstalled: ${pkg.currentVersion || "unknown"}\nCandidate: ${pkg.candidateVersion}\nSource: ${pkg.source}`)}>Details</button></div>)}</div><div className="update-footer"><span>Showing {Math.min(packages.length, 12)} of {available} packages</span></div></section></>;
}

function SettingsPage({ provider, snapshot, elevated, operation, onEdit, onManageApplications, onOpenContainers, onSystemAction }: { provider: ProviderEnvelope; snapshot?: AgentSnapshot; elevated: boolean; operation: SystemJob | null; onEdit: () => void; onManageApplications: () => void; onOpenContainers: () => void; onSystemAction: (action: SystemJob["action"]) => void }) {
  const providerLabel = provider.mode === "live" ? `Live agent · ${snapshot?.host.hostname}` : provider.mode === "unavailable" ? "Agent unavailable" : "Mock provider active";
  const configuredGroups = provider.configuration?.applications.length ?? 0;
  const configuredAliases = Object.keys(provider.configuration?.containerAliases ?? {}).length;
  const busy = operation?.status === "running";
  return <><PageHeader eyebrow="Configuration" title="Settings" description="Configure dashboard behavior and perform protected host actions."><button className="button primary" onClick={onEdit}>{elevated ? "Edit settings" : "Elevate to edit"}</button></PageHeader>{provider.mode === "unavailable" && <div className="provider-notice"><StatusDot state="warning" /><span><strong>Live provider unavailable</strong>{provider.error}</span></div>}{provider.configurationError && <div className="provider-notice"><StatusDot state="warning" /><span><strong>Configuration fallback active</strong>{provider.configurationError}</span></div>}{operation && ["reboot", "poweroff"].includes(operation.action) && <div className={`operation-notice ${operation.status}`}><StatusDot state={operation.status === "failed" ? "warning" : "healthy"} /><span><strong>Host {operation.action} {operation.status}</strong>{operation.error || "The server may disconnect while the action completes."}</span></div>}<section className="settings-grid"><article className="card settings-card"><div className="setting-icon">◫</div><div><h2>Host provider</h2><p>Display name and telemetry refresh interval.</p><span className={`provider-state ${provider.mode === "unavailable" ? "warning" : ""}`}><StatusDot state={provider.mode === "unavailable" ? "warning" : "healthy"} /> {providerLabel}</span></div><button onClick={onEdit}>Configure</button></article><article className="card settings-card"><div className="setting-icon">◆</div><div><h2>Container engine</h2><p>Docker inventory, Compose metadata, and utilization.</p><span className="provider-state"><StatusDot state={snapshot && !snapshot.docker.connected ? "warning" : "healthy"} /> {snapshot ? snapshot.docker.connected ? `Docker ${snapshot.docker.version ?? "connected"}` : "Docker unavailable" : "Docker mock connected"}</span></div><button onClick={onOpenContainers}>Open containers</button></article><article className="card settings-card"><div className="setting-icon">▦</div><div><h2>Application mapping</h2><p>Create groups, rename them, and assign containers.</p><span className="provider-state"><StatusDot state="healthy" /> {configuredGroups} groups · {configuredAliases} aliases</span></div><button onClick={onManageApplications}>Manage groups</button></article><article className="card settings-card"><div className="setting-icon">◷</div><div><h2>Administrative elevation</h2><p>Linux PAM authentication and tab-scoped timeout.</p><span className="provider-state"><StatusDot state="healthy" /> PAM · {provider.configuration?.settings?.elevationTimeoutSeconds ?? 900}s timeout</span></div><button onClick={onEdit}>Edit policy</button></article><article className="card settings-card host-power-card"><div className="setting-icon warning">⌁</div><div><h2>Host power</h2><p>Restart or shut down the Linux server.</p><span className="provider-state warning"><StatusDot state="warning" /> Confirmation required</span></div><div className="power-actions"><button disabled={busy} onClick={() => onSystemAction("reboot")}>Restart server</button><button className="danger" disabled={busy} onClick={() => onSystemAction("poweroff")}>Shut down</button></div></article></section></>;
}

function SettingsEditor({ configuration, onClose, onSave }: { configuration?: DashboardConfig; onClose: () => void; onSave: (configuration: DashboardConfig) => Promise<void> }) {
  const [displayName, setDisplayName] = useState(configuration?.host?.displayName ?? "");
  const [refreshInterval, setRefreshInterval] = useState(configuration?.settings?.refreshIntervalSeconds ?? 10);
  const [elevationTimeout, setElevationTimeout] = useState(configuration?.settings?.elevationTimeoutSeconds ?? 900);
  const [managedServices, setManagedServices] = useState((configuration?.settings?.managedServices ?? ["nginx.service", "docker.service"]).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true); setError("");
    try {
      await onSave({ ...(configuration ?? { version: 1, applications: [], containerAliases: {} }), host: displayName.trim() ? { displayName: displayName.trim() } : undefined, settings: { refreshIntervalSeconds: refreshInterval, elevationTimeoutSeconds: elevationTimeout, managedServices: managedServices.split(/[\n,]+/).map((unit) => unit.trim()).filter(Boolean) } });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Settings could not be saved."); setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal-card" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Dashboard configuration</span><h2>Edit settings</h2></div><button className="close-button" onClick={onClose}>×</button></div><p>These settings are stored in the persistent OpsDeck data volume.</p><label className="field-label">Host display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Use system hostname" /></label><label className="field-label">Telemetry refresh interval (5–60 seconds)<input type="number" min={5} max={60} value={refreshInterval} onChange={(event) => setRefreshInterval(Math.min(60, Math.max(5, Number(event.target.value))))} /></label><label className="field-label">Elevation timeout (60–3600 seconds)<input type="number" min={60} max={3600} value={elevationTimeout} onChange={(event) => setElevationTimeout(Math.min(3600, Math.max(60, Number(event.target.value))))} /></label><label className="field-label">Managed systemd services (one unit per line)<textarea rows={4} value={managedServices} onChange={(event) => setManagedServices(event.target.value)} placeholder="nginx.service" /></label>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save settings"}</button></div></section></div>;
}

function ElevationModal({ onClose, onElevated }: { onClose: () => void; onElevated: (state: ElevationState) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/session/elevate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      setPassword("");
      const payload = await response.json() as ElevationState & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Elevation failed.");
      onElevated({ token: payload.token, expiresAt: payload.expiresAt, username: payload.username });
    } catch (reason) { setPassword(""); setError(reason instanceof Error ? reason.message : "Elevation failed."); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal-card" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit}><div className="modal-header"><div><span className="section-kicker">Administrative access</span><h2>Elevate this tab</h2></div><button type="button" className="close-button" onClick={onClose}>×</button></div><p>Enter the Linux credentials for an authorized administrator. On Ubuntu, this is normally your username and sudo password. Access expires automatically and is removed when this tab closes.</p><label className="field-label">Linux username<input autoFocus value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label><label className="field-label">Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !username || !password}>{busy ? "Verifying…" : "Elevate"}</button></div></form></div>;
}

function GroupEditor({ applications, containers, configuration, onClose, onSave }: { applications: ApplicationDefinition[]; containers: Container[]; configuration?: DashboardConfig; onClose: () => void; onSave: (configuration: DashboardConfig) => Promise<void> }) {
  const [groups, setGroups] = useState(applications);
  const [names, setNames] = useState(() => Object.fromEntries(applications.map((application) => [application.name, application.name])));
  const [assignments, setAssignments] = useState(() => Object.fromEntries(containers.map((container) => [container.id, container.application])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const addGroup = () => {
    const key = `__new-${Date.now()}`;
    const index = groups.length;
    setGroups((current) => [...current, { name: key, description: "Custom application group", color: applicationColors[index % applicationColors.length], accent: "NG" }]);
    setNames((current) => ({ ...current, [key]: "New group" }));
  };
  const save = async () => {
    setError("");
    const normalizedNames = groups.map((application) => names[application.name]?.trim() || "");
    if (normalizedNames.some((name) => !name)) { setError("Every group needs a name."); return; }
    if (new Set(normalizedNames.map((name) => name.toLowerCase())).size !== normalizedNames.length) { setError("Group names must be unique."); return; }
    setBusy(true);
    const nextApplications: DashboardApplicationConfig[] = groups.map((application, index) => {
      const existing = configuration?.applications.find((item) => item.name === application.name);
      const generatedID = application.name.startsWith("__new-") ? `group-${application.name.slice(6)}` : `group-${index + 1}`;
      return { id: existing?.id || generatedID, name: normalizedNames[index], description: existing?.description || application.description, color: existing?.color || application.color, accent: existing?.accent || application.accent, match: { containerNames: containers.filter((container) => assignments[container.id] === application.name).map((container) => container.runtimeName || container.name) } };
    });
    try { await onSave({ ...configuration, version: 1, applications: nextApplications, containerAliases: configuration?.containerAliases ?? {} }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Groups could not be saved."); setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal-card group-editor" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Application mapping</span><h2>Manage groups</h2></div><button className="close-button" onClick={onClose}>×</button></div><p>Create or rename groups and assign containers. The mapping persists on the server and does not modify Docker Compose labels.</p><div className="editor-heading-row"><h3 className="editor-heading">Group names</h3><button className="button ghost compact" onClick={addGroup}>+ Add group</button></div><div className="group-fields">{groups.map((application) => <label className="field-label" key={application.name}>{application.name.startsWith("__new-") ? "New group" : application.name}<input value={names[application.name] ?? ""} onChange={(event) => setNames((current) => ({ ...current, [application.name]: event.target.value }))} /></label>)}</div><h3 className="editor-heading">Container assignment</h3><div className="assignment-list">{containers.map((container) => <label key={container.id}><span><strong>{container.name}</strong><small>{container.image}</small></span><select value={assignments[container.id]} onChange={(event) => setAssignments((current) => ({ ...current, [container.id]: event.target.value }))}>{groups.map((application) => <option key={application.name} value={application.name}>{names[application.name] || application.name}</option>)}</select></label>)}</div>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save groups"}</button></div></section></div>;
}

function ContainerDrawer({ container, elevated, busy, onClose, onElevate, onAction }: { container: Container; elevated: boolean; busy: boolean; onClose: () => void; onElevate: () => void; onAction: (action: "start" | "stop" | "restart") => void }) {
  return <div className="drawer-backdrop" onClick={onClose}><aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label={`${container.name} details`}><div className="drawer-header"><div><span className="section-kicker">Container details</span><h2>{container.name}</h2><span className={`state-label ${container.state}`}><StatusDot state={container.state} />{container.health}</span></div><button className="close-button" onClick={onClose} aria-label="Close details">×</button></div><div className="drawer-section"><h3>Runtime</h3><dl><div><dt>Container ID</dt><dd className="mono-cell">{container.id}</dd></div>{container.runtimeName && container.runtimeName !== container.name && <div><dt>Runtime name</dt><dd>{container.runtimeName}</dd></div>}<div><dt>Image</dt><dd>{container.image}</dd></div><div><dt>Application</dt><dd>{container.application}</dd></div>{container.composeProject && <div><dt>Compose project</dt><dd>{container.composeProject}</dd></div>}<div><dt>Uptime</dt><dd>{container.uptime}</dd></div><div><dt>Published ports</dt><dd>{container.ports}</dd></div></dl></div><div className="drawer-section"><h3>Live utilization</h3><div className="drawer-metrics"><span><small>CPU</small><strong>{container.cpu.toFixed(1)}%</strong></span><span><small>Memory</small><strong>{container.memoryText}</strong></span><span><small>Network I/O</small><strong>{container.network}</strong></span></div><Sparkline values={metricSeries.cpu.map((v, index) => Math.max(1, v * (container.cpu > 2 ? 0.9 : 0.08) + index % 3))} color={container.state === "unhealthy" ? "#e8a34a" : "#4aa8e8"} /></div><div className="drawer-actions"><span>{elevated ? "Administrative access active." : "Elevate to control this container."}</span><div>{!elevated ? <button className="action-button" onClick={onElevate}>Elevate</button> : <>{container.state === "stopped" ? <button className="action-button" disabled={busy} onClick={() => onAction("start")}>Start</button> : <button className="action-button danger" disabled={busy} onClick={() => onAction("stop")}>Stop</button>}<button className="action-button" disabled={busy || container.state === "stopped"} onClick={() => onAction("restart")}>Restart</button></>}</div></div></aside></div>;
}

export default function Dashboard() {
  const [page, setPage] = useState<PageId>("overview");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedContainer, setSelectedContainer] = useState<Container | null>(null);
  const [provider, setProvider] = useState<ProviderEnvelope>({ mode: "mock" });
  const [history, setHistory] = useState(metricSeries);
  const [hostMenuOpen, setHostMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [elevationModalOpen, setElevationModalOpen] = useState(false);
  const [groupEditorOpen, setGroupEditorOpen] = useState(false);
  const [settingsEditorOpen, setSettingsEditorOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [busyApplication, setBusyApplication] = useState<string>();
  const [systemOperation, setSystemOperation] = useState<SystemJob | null>(null);
  const [elevation, setElevation] = useState<ElevationState | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const stored = JSON.parse(window.sessionStorage.getItem("opsdeck-elevation") ?? "null") as ElevationState | null;
      return stored?.expiresAt && stored.expiresAt > Date.now() ? stored : null;
    } catch { return null; }
  });

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/live/snapshot", { cache: "no-store" });
        const next = await response.json() as ProviderEnvelope;
        if (active) {
          setProvider(next);
          if (next.mode === "live" && next.snapshot) {
            const memoryPercent = next.snapshot.metrics.memoryTotalBytes
              ? next.snapshot.metrics.memoryUsedBytes / next.snapshot.metrics.memoryTotalBytes * 100
              : 0;
            const networkMbps = next.snapshot.metrics.networkRxBytesPerSecond * 8 / 1_000_000;
            setHistory((current) => ({
              cpu: [...current.cpu.slice(-15), next.snapshot!.metrics.cpuPercent],
              memory: [...current.memory.slice(-15), memoryPercent],
              network: [...current.network.slice(-15), networkMbps],
              diskRead: [...current.diskRead.slice(-15), next.snapshot!.metrics.diskReadBytesPerSecond ?? 0],
              diskWrite: [...current.diskWrite.slice(-15), next.snapshot!.metrics.diskWriteBytesPerSecond ?? 0],
            }));
          }
        }
      } catch {
        if (active) setProvider({ mode: "unavailable", error: "The dashboard data route could not be reached." });
      }
    };
    void refresh();
    const interval = window.setInterval(refresh, (provider.configuration?.settings?.refreshIntervalSeconds ?? 10) * 1000);
    return () => { active = false; window.clearInterval(interval); };
  }, [provider.configuration?.settings?.refreshIntervalSeconds]);

  useEffect(() => {
    if (!elevation) return;
    const remaining = elevation.expiresAt - Date.now();
    const timeout = window.setTimeout(() => {
      window.sessionStorage.removeItem("opsdeck-elevation");
      setElevation(null);
    }, Math.max(0, remaining));
    return () => window.clearTimeout(timeout);
  }, [elevation]);

  useEffect(() => {
    if (!elevation || systemOperation?.status !== "running") return;
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/live/system/jobs/${systemOperation.id}`, { cache: "no-store", headers: { Authorization: `OpsDeck-Elevation ${elevation.token}` } });
        const payload = await response.json() as { job?: SystemJob };
        if (response.ok && payload.job) setSystemOperation(payload.job);
      } catch { /* The host may be restarting or shutting down. */ }
    }, 2000);
    return () => window.clearTimeout(timeout);
  }, [elevation, systemOperation]);

  const snapshot = provider.mode === "live" ? provider.snapshot : undefined;
  const containers = useMemo(() => mapLiveContainers(snapshot, provider.configuration), [snapshot, provider.configuration]);
  const applications = useMemo(() => applicationDefinitions(containers, provider.configuration), [containers, provider.configuration]);
  const hostLabel = provider.configuration?.host?.displayName || snapshot?.host.hostname || "Host overview";
  const alertCount = Math.max(containers.filter((container) => container.state === "unhealthy").length, snapshot?.warnings.length ?? 0);
  const updateCount = snapshot?.updates.available ?? 12;
  const elevated = Boolean(elevation);
  const profileName = elevation?.username || "Local operator";
  const profileInitials = profileName.split(/[^a-z0-9]+/i).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "OP";

  const acceptElevation = (state: ElevationState) => {
    window.sessionStorage.setItem("opsdeck-elevation", JSON.stringify(state));
    setElevation(state); setElevationModalOpen(false); setProfileMenuOpen(false);
  };
  const dropElevation = () => { window.sessionStorage.removeItem("opsdeck-elevation"); setElevation(null); setProfileMenuOpen(false); };
  const openGroupManager = () => elevated ? setGroupEditorOpen(true) : setElevationModalOpen(true);
  const openSettingsEditor = () => elevated ? setSettingsEditorOpen(true) : setElevationModalOpen(true);
  const saveConfiguration = async (configuration: DashboardConfig) => {
    if (!elevation) throw new Error("Administrative elevation is required.");
    const response = await fetch("/api/configuration", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `OpsDeck-Elevation ${elevation.token}` }, body: JSON.stringify(configuration) });
    const payload = await response.json() as { configuration?: DashboardConfig; error?: string };
    if (!response.ok || !payload.configuration) throw new Error(payload.error || "Configuration could not be saved.");
    setProvider((current) => ({ ...current, configuration: payload.configuration, configurationError: undefined }));
    setGroupEditorOpen(false); setSettingsEditorOpen(false);
  };
  const applicationAction = async (application: string, action: "stop" | "restart") => {
    if (!elevation) { setElevationModalOpen(true); return; }
    const targets = containers.filter((container) => container.application === application && container.state !== "stopped");
    if (!targets.length) return;
    const verb = action === "stop" ? "stop" : "restart";
    if (!window.confirm(`Are you sure you want to ${verb} all ${targets.length} running containers in ${application}?${action === "stop" ? " The application will become unavailable." : " Services may be briefly unavailable."}`)) return;
    setBusyApplication(application);
    try {
      const results = await Promise.all(targets.map(async (container) => {
        const response = await fetch(`/api/live/containers/${container.id}/${action}`, { method: "POST", headers: { Authorization: `OpsDeck-Elevation ${elevation.token}` } });
        if (!response.ok) { const payload = await response.json() as { error?: string }; throw new Error(`${container.name}: ${payload.error || "action failed"}`); }
      }));
      void results;
    } catch (reason) { window.alert(reason instanceof Error ? reason.message : `The ${application} action failed.`); }
    finally { setBusyApplication(undefined); }
  };
  const systemAction = async (action: SystemJob["action"]) => {
    if (!elevation) { setElevationModalOpen(true); return; }
    const confirmations: Record<SystemJob["action"], string> = {
      "refresh-repositories": "Refresh APT repository metadata now?",
      "install-updates": `Install all ${updateCount} available package updates now? This may restart services.`,
      reboot: "Are you sure you want to restart the server? OpsDeck and all hosted applications will be temporarily unavailable.",
      poweroff: "Are you sure you want to shut down the server? It will remain offline until it is powered on manually.",
      "cleanup-apt-cache": "Remove downloaded APT package archives? Installed packages are not affected.",
      "cleanup-journals-30d": "Remove archived system journals older than 30 days?",
      "cleanup-journals-1g": "Reduce archived system journals to 1 GB?",
      "cleanup-tempfiles": "Apply the host's configured temporary-file retention policy now?",
    };
    if (!window.confirm(confirmations[action])) return;
    try {
      const response = await fetch(`/api/live/system/${action}`, { method: "POST", headers: { Authorization: `OpsDeck-Elevation ${elevation.token}` } });
      const payload = await response.json() as { job?: SystemJob; error?: string };
      if (!response.ok || !payload.job) throw new Error(payload.error || "The system action could not be started.");
      setSystemOperation(payload.job);
    } catch (reason) { window.alert(reason instanceof Error ? reason.message : "The system action could not be started."); }
  };
  const containerAction = async (action: "start" | "stop" | "restart") => {
    if (!elevation || !selectedContainer) { setElevationModalOpen(true); return; }
    if (!window.confirm(`${action[0].toUpperCase() + action.slice(1)} ${selectedContainer.name}?`)) return;
    setActionBusy(true);
    try {
      const response = await fetch(`/api/live/containers/${selectedContainer.id}/${action}`, { method: "POST", headers: { Authorization: `OpsDeck-Elevation ${elevation.token}` } });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Container action failed.");
      setSelectedContainer(null);
    } catch (reason) { window.alert(reason instanceof Error ? reason.message : "Container action failed."); }
    finally { setActionBusy(false); }
  };

  const navigate = (next: PageId) => { setPage(next); setMenuOpen(false); };
  const badgeFor = (id: string, fallback?: string) => id === "logs" ? String(alertCount) : id === "updates" ? String(updateCount) : fallback;
  const providerName = provider.mode === "live" ? "Live agent" : provider.mode === "unavailable" ? "Agent unavailable" : "Mock provider";
  const providerDetail = provider.mode === "live" ? `Managed · ${snapshot?.docker.containers.length ?? 0} containers` : provider.mode === "unavailable" ? "Using mock fallback" : "Sample data";
  return <div className={`app-shell ${theme}`}>
    <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
      <div className="brand"><span className="brand-mark"><i /><i /><i /></span><div><strong>OpsDeck</strong><small>Infrastructure console</small></div><button className="mobile-close" onClick={() => setMenuOpen(false)}>×</button></div>
      <div className="host-menu-wrap"><button className="host-switcher" onClick={() => { setHostMenuOpen(!hostMenuOpen); setProfileMenuOpen(false); }} aria-expanded={hostMenuOpen}><span className="host-avatar">{hostLabel[0].toUpperCase()}</span><span className="host-copy"><small>Connected host</small><strong>{hostLabel}</strong></span><span className="chevron">⌄</span></button>{hostMenuOpen && <div className="popover host-popover"><strong>{hostLabel}</strong><span>{snapshot?.host.operatingSystem ?? "Host details unavailable"}</span><span>{snapshot ? `${snapshot.host.cpuCount} CPUs · up ${formatDuration(snapshot.host.uptimeSeconds)}` : "Waiting for live provider"}</span><button onClick={() => { navigate("settings"); setHostMenuOpen(false); }}>Open host settings</button></div>}</div>
      <nav>{navSections.map((section) => <div className="nav-section" key={section.label}><span className="nav-label">{section.label}</span>{section.items.map((item) => <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => navigate(item.id as PageId)}><span className="nav-icon">{item.icon}</span><span>{item.label}</span>{"badge" in item && item.badge && <b>{badgeFor(item.id, item.badge)}</b>}</button>)}</div>)}</nav>
      <div className="sidebar-footer"><div className="provider-mini"><span><StatusDot state={provider.mode === "unavailable" ? "warning" : "healthy"} /></span><div><strong>{providerName}</strong><small>{providerDetail}</small></div></div><span className="version">Preview 0.8.1 · storage and security</span></div>
    </aside>
    {menuOpen && <button className="mobile-overlay" onClick={() => setMenuOpen(false)} aria-label="Close navigation" />}
    <main className="main-area">
      <header className="topbar"><button className="menu-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation">☰</button><div className="breadcrumbs"><span>{snapshot?.host.hostname ?? "server01"}</span><b>/</b><strong>{page === "overview" ? "Overview" : navSections.flatMap((s) => [...s.items]).find((item) => item.id === page)?.label}</strong></div><div className="topbar-actions"><span className={`readonly-badge ${elevated ? "elevated" : ""}`}><i /> {elevated ? "Administrative" : "Limited access"}</span><span className={`mock-badge ${provider.mode}`}>{provider.mode === "live" ? "Live data" : provider.mode === "unavailable" ? "Fallback data" : "Mock data"}</span><button className="icon-button" aria-label="Notifications">●<b>{alertCount}</b></button><button className="theme-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle theme">{theme === "dark" ? "☼" : "◐"}</button><div className="profile-wrap"><button className="user-button" onClick={() => { setProfileMenuOpen(!profileMenuOpen); setHostMenuOpen(false); }} aria-expanded={profileMenuOpen}><span>{profileInitials}</span><div><strong>{profileName}</strong><small>{elevated ? "Administrative access" : "Limited session"}</small></div><i>⌄</i></button>{profileMenuOpen && <div className="popover profile-popover"><strong>Session access</strong><span>{elevated ? `${elevation!.username} · elevated until ${new Date(elevation!.expiresAt).toLocaleTimeString()}` : "Limited access"}</span>{elevated ? <button onClick={dropElevation}>Drop administrative access</button> : <button onClick={() => { setProfileMenuOpen(false); setElevationModalOpen(true); }}>Elevate privileges</button>}<button onClick={() => { setTheme(theme === "dark" ? "light" : "dark"); setProfileMenuOpen(false); }}>Switch to {theme === "dark" ? "light" : "dark"} theme</button></div>}</div></div></header>
      <div className="content">
        {provider.mode === "unavailable" && page !== "settings" && <div className="provider-notice"><StatusDot state="warning" /><span><strong>Live agent unavailable; showing mock fallback.</strong>{provider.error}</span><button onClick={() => setPage("settings")}>Review settings</button></div>}
        {provider.configurationError && page !== "settings" && <div className="provider-notice"><StatusDot state="warning" /><span><strong>Dashboard configuration could not be loaded.</strong>{provider.configurationError}</span><button onClick={() => setPage("settings")}>Review settings</button></div>}
        {page === "overview" && <Overview onNavigate={navigate} snapshot={snapshot} providerMode={provider.mode} containers={containers} applications={applications} history={history} hostLabel={hostLabel} />}
        {page === "applications" && <ApplicationsPage onSelect={setSelectedContainer} onManage={openGroupManager} onApplicationAction={applicationAction} containers={containers} applications={applications} elevated={elevated} busyApplication={busyApplication} />}
        {page === "containers" && <ContainersPage onSelect={setSelectedContainer} containers={containers} dockerConnected={snapshot?.docker.connected ?? true} />}
        {page === "services" && <ServicesPage services={snapshot?.services} managedUnits={provider.configuration?.settings?.managedServices ?? ["nginx.service", "docker.service"]} elevation={elevation} onElevate={() => setElevationModalOpen(true)} />}
        {page === "storage" && <EnhancedStoragePage filesystems={snapshot?.filesystems} metrics={snapshot?.metrics} history={history} elevation={elevation} onElevate={() => setElevationModalOpen(true)} />}
        {page === "logs" && <LogsPage agentLogs={snapshot?.logs} configuration={provider.configuration} elevated={elevated} onSaveConfiguration={saveConfiguration} onElevate={() => setElevationModalOpen(true)} />}
        {page === "updates" && <UpdatesPage updates={snapshot?.updates} elevated={elevated} operation={systemOperation} onAction={systemAction} />}
        {page === "security" && <SecurityPage security={snapshot?.security} />}
        {page === "settings" && <SettingsPage provider={provider} snapshot={snapshot} elevated={elevated} operation={systemOperation} onEdit={openSettingsEditor} onManageApplications={openGroupManager} onOpenContainers={() => navigate("containers")} onSystemAction={systemAction} />}
      </div>
    </main>
    {selectedContainer && <ContainerDrawer container={selectedContainer} elevated={elevated} busy={actionBusy} onClose={() => setSelectedContainer(null)} onElevate={() => setElevationModalOpen(true)} onAction={containerAction} />}
    {elevationModalOpen && <ElevationModal onClose={() => setElevationModalOpen(false)} onElevated={acceptElevation} />}
    {groupEditorOpen && <GroupEditor applications={applications} containers={containers} configuration={provider.configuration} onClose={() => setGroupEditorOpen(false)} onSave={saveConfiguration} />}
    {settingsEditorOpen && <SettingsEditor configuration={provider.configuration} onClose={() => setSettingsEditorOpen(false)} onSave={saveConfiguration} />}
  </div>;
}
