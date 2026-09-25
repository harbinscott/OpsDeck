"use client";

import { useMemo, useState } from "react";
import type { AgentFilesystem, AgentMetrics, AgentSecurity, AgentService, CleanupCandidate, StorageAnalysis, SystemJob } from "./lib/snapshot";

type Elevation = { token: string; expiresAt: number; username: string } | null;

function formatBytes(bytes: number, precision = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : precision)} ${units[index]}`;
}

function PageHeader({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: React.ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{children && <div className="page-actions">{children}</div>}</div>;
}

function Status({ good, children }: { good: boolean; children: React.ReactNode }) {
  return <span className={`provider-state ${good ? "" : "warning"}`}><span className={`status-dot ${good ? "healthy" : "warning"}`} />{children}</span>;
}

function TinyBars({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1, ...values);
  return <div className="sparkline" aria-label="Recent throughput history">{values.map((value, index) => <span key={index} style={{ height: `${Math.max(8, value / max * 100)}%`, backgroundColor: color, opacity: .42 + index / values.length / 2 }} />)}</div>;
}

export function StoragePage({ filesystems, metrics, history, elevation, onElevate }: { filesystems?: AgentFilesystem[]; metrics?: AgentMetrics; history: { diskRead: number[]; diskWrite: number[] }; elevation: Elevation; onElevate: () => void }) {
  const volumes = filesystems ?? [];
  const total = volumes.reduce((sum, item) => sum + item.totalBytes, 0);
  const used = volumes.reduce((sum, item) => sum + item.usedBytes, 0);
  const [expanded, setExpanded] = useState<string>();
  const [analyses, setAnalyses] = useState<Record<string, StorageAnalysis>>({});
  const [scanBusy, setScanBusy] = useState<string>();
  const [scanError, setScanError] = useState("");
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [candidates, setCandidates] = useState<CleanupCandidate[]>([]);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupError, setCleanupError] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const scan = async (filesystem: AgentFilesystem) => {
    const key = filesystem.id || filesystem.mount;
    if (expanded === key) { setExpanded(undefined); return; }
    setExpanded(key); setScanError("");
    if (analyses[key]) return;
    setScanBusy(key);
    try {
      const response = await fetch(`/api/live/storage/analysis?mount=${encodeURIComponent(filesystem.mount)}`, { cache: "no-store" });
      const payload = await response.json() as { analysis?: StorageAnalysis; error?: string };
      if (!response.ok || !payload.analysis) throw new Error(payload.error || "The storage scan failed.");
      setAnalyses((current) => ({ ...current, [key]: payload.analysis! }));
    } catch (reason) { setScanError(reason instanceof Error ? reason.message : "The storage scan failed."); }
    finally { setScanBusy(undefined); }
  };
  const openCleanup = async () => {
    setCleanupOpen(true); setCleanupBusy(true); setCleanupError(""); setSelected({});
    try {
      const response = await fetch("/api/live/storage/cleanup", { cache: "no-store" });
      const payload = await response.json() as { candidates?: CleanupCandidate[]; error?: string };
      if (!response.ok || !payload.candidates) throw new Error(payload.error || "Cleanup suggestions could not be calculated.");
      setCandidates(payload.candidates);
    } catch (reason) { setCleanupError(reason instanceof Error ? reason.message : "Cleanup suggestions could not be calculated."); }
    finally { setCleanupBusy(false); }
  };
  const runCleanup = async () => {
    if (!elevation) { onElevate(); return; }
    const chosen = candidates.filter((candidate) => candidate.available && candidate.action && selected[candidate.id]);
    if (!chosen.length) return;
    if (!window.confirm(`Run ${chosen.length} selected cleanup operation${chosen.length === 1 ? "" : "s"}? Review the listed impact before continuing.`)) return;
    setCleanupBusy(true); setCleanupError("");
    try {
      for (const candidate of chosen) {
        const response = await fetch(`/api/live/storage/cleanup/${candidate.action}`, { method: "POST", headers: { Authorization: `OpsDeck-Elevation ${elevation.token}` } });
        const payload = await response.json() as { job?: SystemJob; error?: string };
        if (!response.ok) throw new Error(`${candidate.label}: ${payload.error || "cleanup failed"}`);
        if (payload.job) await waitForJob(payload.job, elevation.token);
      }
      setCleanupOpen(false);
    } catch (reason) { setCleanupError(reason instanceof Error ? reason.message : "Cleanup failed."); }
    finally { setCleanupBusy(false); }
  };
  return <>
    <PageHeader eyebrow="System" title="Storage" description="Accurate filesystem capacity, inode pressure, on-demand content analysis, and guarded cleanup suggestions.">
      <button className="button primary" onClick={openCleanup}>Analyze cleanup</button>
    </PageHeader>
    <section className="storage-summary-grid">
      <article className="card storage-total-card"><span className="section-kicker">Unique filesystems</span><strong>{total ? `${(used / total * 100).toFixed(0)}%` : "—"}</strong><p>{formatBytes(used)} used of {formatBytes(total)} across {volumes.length} backing filesystem{volumes.length === 1 ? "" : "s"}.</p><span className="capacity-bar"><i className="blue" style={{ width: `${total ? used / total * 100 : 0}%` }} /></span></article>
      <article className="card io-card compact-io"><span className="section-kicker">Physical disks</span><div className="io-pair"><span><strong>{formatBytes(metrics?.diskReadBytesPerSecond ?? 0)}/s</strong><small>read</small></span><span><strong>{formatBytes(metrics?.diskWriteBytesPerSecond ?? 0)}/s</strong><small>write</small></span></div><TinyBars values={history.diskRead.map((value, index) => value + (history.diskWrite[index] ?? 0))} color="#2f9fd8" /><p className="io-context">Aggregate physical-device throughput over the last 150 seconds.</p></article>
    </section>
    <section className="card filesystem-card"><div className="section-header"><div><span className="section-kicker">Capacity</span><h2>Backing filesystems</h2></div><span className="readonly-caption">Temporary directories inherit their backing filesystem</span></div>
      <div className="filesystem-list">{volumes.map((filesystem) => {
        const key = filesystem.id || filesystem.mount;
        const analysis = analyses[key];
        const inodeWarning = (filesystem.inodesUsedPercent ?? 0) >= 80;
        return <article className={`filesystem-item ${expanded === key ? "expanded" : ""}`} key={key}>
          <button className="filesystem-main" onClick={() => void scan(filesystem)} aria-expanded={expanded === key}>
            <span className={`volume-icon ${filesystem.usedPercent >= 85 ? "orange" : "blue"}`}>▰</span>
            <span className="filesystem-name"><strong>{filesystem.mount === "/" ? "System" : filesystem.mount}</strong><small>{filesystem.device} · {filesystem.type} · {filesystem.category || "local"}</small></span>
            <span className="filesystem-capacity"><span>{formatBytes(filesystem.usedBytes)} of {formatBytes(filesystem.totalBytes)}</span><strong>{filesystem.usedPercent.toFixed(0)}%</strong><span className="capacity-bar"><i className={filesystem.usedPercent >= 85 ? "orange" : "blue"} style={{ width: `${filesystem.usedPercent}%` }} /></span></span>
            <span className="expand-label">{scanBusy === key ? "Scanning…" : expanded === key ? "Close" : "Analyze"}</span>
          </button>
          {expanded === key && <div className="filesystem-details">
            <div className="filesystem-facts"><span><small>Available</small><strong>{formatBytes(filesystem.availableBytes ?? Math.max(0, filesystem.totalBytes - filesystem.usedBytes))}</strong></span><span><small>Reserved</small><strong>{formatBytes(filesystem.reservedBytes ?? 0)}</strong></span><span className={inodeWarning ? "warning-text" : ""}><small>Inodes</small><strong>{filesystem.inodesTotal ? `${filesystem.inodesUsedPercent.toFixed(1)}% used` : "Unavailable"}</strong></span><span><small>Mounts</small><strong>{(filesystem.mounts?.length ?? 1).toString()}</strong></span></div>
            {filesystem.mounts?.length > 1 && <p className="mount-context">Also mounted at: {filesystem.mounts.filter((mount) => mount !== filesystem.mount).join(", ")}</p>}
            {scanBusy === key && <div className="scan-state">Scanning this filesystem without following symbolic links or crossing onto other filesystems…</div>}
            {analysis && <div className="analysis-columns"><StorageRanking title="Largest directories" entries={analysis.topDirectories} /><StorageRanking title="Largest files" entries={analysis.topFiles} /><p className="scan-meta">Scanned {analysis.entriesVisited.toLocaleString()} entries in {(analysis.durationMillis / 1000).toFixed(1)}s · {analysis.crossMountsSkipped} other mounts skipped · {analysis.permissionErrors} unreadable entries{analysis.truncated ? " · scan limit reached" : ""}</p></div>}
            {scanError && scanBusy !== key && <div className="form-error">{scanError}</div>}
          </div>}
        </article>;
      })}</div>
    </section>
    {cleanupOpen && <div className="modal-backdrop" onMouseDown={() => !cleanupBusy && setCleanupOpen(false)}><section className="modal-card cleanup-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Storage cleanup</span><h2>Review reclaimable space</h2></div><button className="close-button" onClick={() => setCleanupOpen(false)}>×</button></div><p>Nothing is selected automatically. OpsDeck only runs the named operation shown for each candidate; arbitrary file deletion is not available.</p>{cleanupBusy && candidates.length === 0 ? <div className="scan-state">Calculating cleanup suggestions…</div> : <div className="cleanup-list">{candidates.map((candidate) => <label className={`cleanup-item ${!candidate.available ? "disabled" : ""}`} key={candidate.id}><input type="checkbox" disabled={!candidate.available || !candidate.action || cleanupBusy} checked={Boolean(selected[candidate.id])} onChange={(event) => setSelected((current) => ({ ...current, [candidate.id]: event.target.checked }))} /><span><strong>{candidate.label}</strong><small>{candidate.description}</small>{candidate.detail && <em>{candidate.detail}</em>}</span><span className={`risk-pill ${candidate.risk}`}>{candidate.risk}</span><b>{formatBytes(candidate.reclaimableBytes)}</b></label>)}</div>}{cleanupError && <div className="form-error">{cleanupError}</div>}<div className="modal-actions"><button className="button ghost" onClick={() => setCleanupOpen(false)}>Cancel</button><button className="button primary" disabled={cleanupBusy || !candidates.some((candidate) => selected[candidate.id])} onClick={() => void runCleanup()}>{cleanupBusy ? "Working…" : elevation ? "Run selected cleanup" : "Elevate to clean"}</button></div></section></div>}
  </>;
}

async function waitForJob(job: SystemJob, token: string) {
  let current = job;
  for (let attempt = 0; attempt < 1440 && current.status === "running"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const response = await fetch(`/api/live/system/jobs/${current.id}`, { cache: "no-store", headers: { Authorization: `OpsDeck-Elevation ${token}` } });
    const payload = await response.json() as { job?: SystemJob; error?: string };
    if (!response.ok || !payload.job) throw new Error(payload.error || "Cleanup status could not be read.");
    current = payload.job;
  }
  if (current.status === "running") throw new Error("Cleanup is still running after two hours. Review the agent journal before starting another operation.");
  if (current.status === "failed") throw new Error(current.error || "Cleanup failed.");
}

function StorageRanking({ title, entries }: { title: string; entries: StorageAnalysis["topFiles"] }) {
  return <div className="storage-ranking"><h3>{title}</h3>{entries.length ? entries.map((entry) => <div key={entry.path}><span title={entry.path}>{entry.path}</span><strong>{formatBytes(entry.sizeBytes)}</strong></div>) : <p>No readable entries were found.</p>}</div>;
}

export function ServicesPage({ services, managedUnits, elevation, onElevate }: { services?: AgentService[]; managedUnits: string[]; elevation: Elevation; onElevate: () => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "inactive" | "failed">("all");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const rows = useMemo(() => (services ?? []).filter((service) => (filter === "all" || service.active === filter || service.sub === filter) && `${service.unit} ${service.description}`.toLowerCase().includes(query.toLowerCase())), [services, query, filter]);
  const action = async (service: AgentService, verb: "start" | "stop" | "restart") => {
    if (!elevation) { onElevate(); return; }
    const impact = verb === "stop" ? "This service will become unavailable." : verb === "restart" ? "The service may be briefly unavailable." : "";
    if (!window.confirm(`${verb[0].toUpperCase() + verb.slice(1)} ${service.unit}? ${impact}`)) return;
    setBusy(service.unit); setError("");
    try {
      const response = await fetch(`/api/live/services/${encodeURIComponent(service.unit)}/${verb}`, { method: "POST", headers: { Authorization: `OpsDeck-Elevation ${elevation.token}` } });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "The service action failed.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The service action failed."); }
    finally { setBusy(undefined); }
  };
  return <><PageHeader eyebrow="Systemd" title="Services" description="Host-level services, including applications that do not run as Docker containers."><span className="readonly-hint">{managedUnits.length} managed unit{managedUnits.length === 1 ? "" : "s"}</span></PageHeader>
    {error && <div className="form-error page-error">{error}</div>}
    <section className="card table-card"><div className="table-tools"><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search services…" aria-label="Search services" /></label><div className="filter-pills">{(["all", "active", "inactive", "failed"] as const).map((value) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div><span className="result-count">{rows.length} results</span></div>
      <div className="service-list">{rows.map((service) => { const managed = managedUnits.includes(service.unit); return <article className="service-row" key={service.unit}><span><Status good={service.active === "active"}>{service.sub}</Status></span><div><strong>{service.unit}</strong><small>{service.description}</small></div><span className="service-enabled">{service.enabled || "unknown"}</span><div className="service-actions">{managed ? <>{service.active === "active" ? <button disabled={busy === service.unit} onClick={() => void action(service, "stop")}>Stop</button> : <button disabled={busy === service.unit} onClick={() => void action(service, "start")}>Start</button>}<button disabled={busy === service.unit || service.active !== "active"} onClick={() => void action(service, "restart")}>Restart</button></> : <span title="Add this unit in Settings to enable controls">Read only</span>}</div></article>; })}</div>
      {!rows.length && <div className="empty-state"><h3>No matching services</h3><p>Try a different service name or state.</p></div>}
    </section></>;
}

export function SecurityPage({ security }: { security?: AgentSecurity }) {
  const [listenerQuery, setListenerQuery] = useState("");
  if (!security) return <><PageHeader eyebrow="Security" title="Security" description="Firewall, network exposure, SSH, updates, and VPN posture." /><div className="provider-notice"><span className="status-dot warning" /><span><strong>Waiting for the live security provider</strong>The installed agent must be upgraded before this page can report host security data.</span></div></>;
  const firewall = security.firewall;
  const vpn = security.vpn;
  const listeners = security.listeners.filter((listener) => `${listener.address} ${listener.port} ${listener.process ?? ""}`.toLowerCase().includes(listenerQuery.toLowerCase()));
  const sshFindings = [
    { label: "Root login", value: security.ssh.permitRootLogin || "Unknown", good: !["yes", "without-password"].includes((security.ssh.permitRootLogin || "").toLowerCase()) },
    { label: "Password authentication", value: security.ssh.passwordAuthentication || "Unknown", good: security.ssh.passwordAuthentication === "no" },
    { label: "Public key authentication", value: security.ssh.pubkeyAuthentication || "Unknown", good: security.ssh.pubkeyAuthentication !== "no" },
    { label: "Empty passwords", value: security.ssh.permitEmptyPasswords || "Unknown", good: security.ssh.permitEmptyPasswords !== "yes" },
  ];
  return <><PageHeader eyebrow="Security" title="Security" description="Concrete host exposure and access posture. Configuration remains read-only until rollback-protected changes are enabled."><span className="readonly-hint">Collected {new Date(security.collectedAt).toLocaleTimeString()}</span></PageHeader>
    <section className="security-summary-grid">
      <article className="card security-card"><span className="section-kicker">Firewall</span><h2>UFW</h2><Status good={firewall.enabled}>{firewall.enabled ? "Active" : firewall.installed ? "Inactive" : "Unavailable"}</Status><dl><div><dt>Incoming</dt><dd>{firewall.defaultIncoming || "Unknown"}</dd></div><div><dt>Outgoing</dt><dd>{firewall.defaultOutgoing || "Unknown"}</dd></div><div><dt>Logging</dt><dd>{firewall.logging || "Unknown"}</dd></div><div><dt>Rules</dt><dd>{firewall.rules.length}</dd></div></dl>{firewall.error && <p className="warning-text">{firewall.error}</p>}</article>
      <article className="card security-card vpn-card"><span className="section-kicker">VPN</span><h2>{vpn.provider || "VPN"}</h2><Status good={vpn.connected}>{vpn.connected ? "Connected" : vpn.installed ? "Disconnected" : "Unavailable"}</Status>{vpn.updateAvailable && <div className="inline-warning">A NordVPN application update is available.</div>}<dl><div><dt>Server</dt><dd>{vpn.server || "—"}</dd></div><div><dt>Exit IP</dt><dd>{vpn.ip || "—"}</dd></div><div><dt>Location</dt><dd>{[vpn.city, vpn.country].filter(Boolean).join(", ") || "—"}</dd></div><div><dt>Tunnel</dt><dd>{[vpn.technology, vpn.protocol].filter(Boolean).join(" / ") || "—"}</dd></div><div><dt>Auto-connect</dt><dd>{vpn.autoConnect == null ? "Unknown" : vpn.autoConnect ? "Enabled" : "Disabled"}</dd></div><div><dt>Default route</dt><dd>{vpn.defaultRouteInterface || "Unknown"}</dd></div><div><dt>Transfer</dt><dd>{vpn.received && vpn.sent ? `${vpn.received} ↓ / ${vpn.sent} ↑` : "—"}</dd></div><div><dt>Uptime</dt><dd>{vpn.uptime || "—"}</dd></div></dl>{vpn.error && <p className="warning-text">{vpn.error}</p>}</article>
      <article className="card security-card"><span className="section-kicker">OpenSSH</span><h2>Access posture</h2><Status good={security.ssh.available}>{security.ssh.available ? `Listening on ${security.ssh.port || "configured port"}` : "Unavailable"}</Status><div className="posture-list">{sshFindings.map((finding) => <span key={finding.label}><i className={finding.good ? "good" : "warning"} /><small>{finding.label}</small><strong>{finding.value}</strong></span>)}</div>{security.ssh.error && <p className="warning-text">{security.ssh.error}</p>}</article>
      <article className="card security-card"><span className="section-kicker">Patching</span><h2>Automatic updates</h2><Status good={security.automaticUpdates.enabled && security.automaticUpdates.timerEnabled}>{security.automaticUpdates.enabled ? "Enabled" : "Review configuration"}</Status><dl><div><dt>Service</dt><dd>{security.automaticUpdates.enabled ? "Enabled" : "Disabled"}</dd></div><div><dt>Timer</dt><dd>{security.automaticUpdates.timerEnabled ? security.automaticUpdates.timerActive ? "Enabled and active" : "Enabled" : "Disabled"}</dd></div><div><dt>Last run</dt><dd>{security.automaticUpdates.lastRun || "Unavailable"}</dd></div></dl></article>
    </section>
    <section className="security-detail-grid"><article className="card firewall-rules"><div className="section-header"><div><span className="section-kicker">UFW</span><h2>Firewall rules</h2></div><span className="readonly-caption">Read only</span></div>{firewall.rules.length ? firewall.rules.map((rule) => <div className="firewall-rule" key={`${rule.index}-${rule.raw}`}><b>{rule.index}</b><strong>{rule.action}</strong><span>{rule.to}</span><small>from {rule.from}</small></div>) : <div className="empty-state"><p>{firewall.enabled ? "No user rules were reported." : "Enable UFW from a trusted administrative session before relying on host filtering."}</p></div>}</article>
      <article className="card listener-card"><div className="section-header"><div><span className="section-kicker">Network</span><h2>Listening ports</h2></div><label className="compact-search"><input value={listenerQuery} onChange={(event) => setListenerQuery(event.target.value)} placeholder="Filter…" /></label></div><div className="listener-list">{listeners.map((listener, index) => <div key={`${listener.protocol}-${listener.address}-${listener.port}-${index}`}><span className={`scope-pill ${listener.scope}`}>{listener.scope}</span><strong>{listener.port}/{listener.protocol}</strong><span>{listener.address}</span><small>{listener.process ? `${listener.process}${listener.pid ? ` · PID ${listener.pid}` : ""}` : "Process unavailable"}</small></div>)}</div></article>
    </section>
  </>;
}
