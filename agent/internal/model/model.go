package model

import "time"

type Snapshot struct {
	SchemaVersion int          `json:"schemaVersion"`
	CollectedAt   time.Time    `json:"collectedAt"`
	Host          Host         `json:"host"`
	Metrics       Metrics      `json:"metrics"`
	Filesystems   []Filesystem `json:"filesystems"`
	Docker        Docker       `json:"docker"`
	Logs          []LogEntry   `json:"logs"`
	Updates       Updates      `json:"updates"`
	Services      []Service    `json:"services"`
	Security      Security     `json:"security"`
	Warnings      []string     `json:"warnings"`
}

type Host struct {
	Hostname        string   `json:"hostname"`
	OperatingSystem string   `json:"operatingSystem"`
	Kernel          string   `json:"kernel"`
	Architecture    string   `json:"architecture"`
	UptimeSeconds   float64  `json:"uptimeSeconds"`
	CPUCount        int      `json:"cpuCount"`
	Load1           float64  `json:"load1"`
	TemperatureC    *float64 `json:"temperatureC,omitempty"`
}

type Metrics struct {
	CPUPercent              float64 `json:"cpuPercent"`
	MemoryUsedBytes         uint64  `json:"memoryUsedBytes"`
	MemoryTotalBytes        uint64  `json:"memoryTotalBytes"`
	NetworkRxBytesPerSecond float64 `json:"networkRxBytesPerSecond"`
	NetworkTxBytesPerSecond float64 `json:"networkTxBytesPerSecond"`
	DiskReadBytesPerSecond  float64 `json:"diskReadBytesPerSecond"`
	DiskWriteBytesPerSecond float64 `json:"diskWriteBytesPerSecond"`
}

type Filesystem struct {
	ID                string   `json:"id"`
	Device            string   `json:"device"`
	Mount             string   `json:"mount"`
	Mounts            []string `json:"mounts"`
	Type              string   `json:"type"`
	Category          string   `json:"category"`
	ReadOnly          bool     `json:"readOnly"`
	TotalBytes        uint64   `json:"totalBytes"`
	UsedBytes         uint64   `json:"usedBytes"`
	AvailableBytes    uint64   `json:"availableBytes"`
	ReservedBytes     uint64   `json:"reservedBytes"`
	UsedPercent       float64  `json:"usedPercent"`
	InodesTotal       uint64   `json:"inodesTotal"`
	InodesUsed        uint64   `json:"inodesUsed"`
	InodesUsedPercent float64  `json:"inodesUsedPercent"`
}

type StorageEntry struct {
	Path      string     `json:"path"`
	SizeBytes uint64     `json:"sizeBytes"`
	Modified  *time.Time `json:"modified,omitempty"`
}

type StorageAnalysis struct {
	Mount              string         `json:"mount"`
	FilesystemID       string         `json:"filesystemId"`
	ScannedAt          time.Time      `json:"scannedAt"`
	DurationMillis     int64          `json:"durationMillis"`
	TopDirectories     []StorageEntry `json:"topDirectories"`
	TopFiles           []StorageEntry `json:"topFiles"`
	EntriesVisited     uint64         `json:"entriesVisited"`
	PermissionErrors   uint64         `json:"permissionErrors"`
	CrossMountsSkipped uint64         `json:"crossMountsSkipped"`
	Truncated          bool           `json:"truncated"`
}

type CleanupCandidate struct {
	ID               string `json:"id"`
	Label            string `json:"label"`
	Description      string `json:"description"`
	ReclaimableBytes uint64 `json:"reclaimableBytes"`
	Risk             string `json:"risk"`
	Action           string `json:"action"`
	Available        bool   `json:"available"`
	Detail           string `json:"detail,omitempty"`
}

type Docker struct {
	Connected  bool        `json:"connected"`
	Version    string      `json:"version,omitempty"`
	Error      string      `json:"error,omitempty"`
	Containers []Container `json:"containers"`
}

type Container struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Image          string    `json:"image"`
	State          string    `json:"state"`
	Health         string    `json:"health"`
	CPUPercent     float64   `json:"cpuPercent"`
	MemoryBytes    uint64    `json:"memoryBytes"`
	NetworkRxBytes uint64    `json:"networkRxBytes"`
	NetworkTxBytes uint64    `json:"networkTxBytes"`
	Ports          []string  `json:"ports"`
	CreatedAt      time.Time `json:"createdAt"`
	ComposeProject string    `json:"composeProject,omitempty"`
	ComposeService string    `json:"composeService,omitempty"`
}

type LogEntry struct {
	Timestamp time.Time `json:"timestamp"`
	Severity  string    `json:"severity"`
	Source    string    `json:"source"`
	Message   string    `json:"message"`
}

type Updates struct {
	CheckedAt time.Time `json:"checkedAt"`
	Available int       `json:"available"`
	Security  int       `json:"security"`
	Error     string    `json:"error,omitempty"`
	Packages  []Update  `json:"packages"`
}

type Update struct {
	Package          string `json:"package"`
	CurrentVersion   string `json:"currentVersion"`
	CandidateVersion string `json:"candidateVersion"`
	Source           string `json:"source"`
	Security         bool   `json:"security"`
}

type Service struct {
	Unit        string `json:"unit"`
	Description string `json:"description"`
	Load        string `json:"load"`
	Active      string `json:"active"`
	Sub         string `json:"sub"`
	Enabled     string `json:"enabled"`
}

type Security struct {
	CollectedAt      time.Time        `json:"collectedAt"`
	Firewall         Firewall         `json:"firewall"`
	Listeners        []Listener       `json:"listeners"`
	SSH              SSHPosture       `json:"ssh"`
	VPN              VPNStatus        `json:"vpn"`
	AutomaticUpdates AutomaticUpdates `json:"automaticUpdates"`
}

type Firewall struct {
	Provider        string         `json:"provider"`
	Installed       bool           `json:"installed"`
	Enabled         bool           `json:"enabled"`
	Logging         string         `json:"logging,omitempty"`
	DefaultIncoming string         `json:"defaultIncoming,omitempty"`
	DefaultOutgoing string         `json:"defaultOutgoing,omitempty"`
	DefaultRouted   string         `json:"defaultRouted,omitempty"`
	Rules           []FirewallRule `json:"rules"`
	Error           string         `json:"error,omitempty"`
}

type FirewallRule struct {
	Index  int    `json:"index"`
	To     string `json:"to"`
	Action string `json:"action"`
	From   string `json:"from"`
	Raw    string `json:"raw"`
}

type Listener struct {
	Protocol string `json:"protocol"`
	Address  string `json:"address"`
	Port     uint16 `json:"port"`
	Process  string `json:"process,omitempty"`
	PID      int    `json:"pid,omitempty"`
	Scope    string `json:"scope"`
}

type SSHPosture struct {
	Available              bool   `json:"available"`
	Port                   string `json:"port,omitempty"`
	ListenAddress          string `json:"listenAddress,omitempty"`
	PermitRootLogin        string `json:"permitRootLogin,omitempty"`
	PasswordAuthentication string `json:"passwordAuthentication,omitempty"`
	PubkeyAuthentication   string `json:"pubkeyAuthentication,omitempty"`
	PermitEmptyPasswords   string `json:"permitEmptyPasswords,omitempty"`
	X11Forwarding          string `json:"x11Forwarding,omitempty"`
	AllowTcpForwarding     string `json:"allowTcpForwarding,omitempty"`
	Error                  string `json:"error,omitempty"`
}

type VPNStatus struct {
	Provider              string            `json:"provider"`
	Installed             bool              `json:"installed"`
	Connected             bool              `json:"connected"`
	UpdateAvailable       bool              `json:"updateAvailable"`
	AutoConnect           *bool             `json:"autoConnect,omitempty"`
	KillSwitch            *bool             `json:"killSwitch,omitempty"`
	Server                string            `json:"server,omitempty"`
	Hostname              string            `json:"hostname,omitempty"`
	IP                    string            `json:"ip,omitempty"`
	Country               string            `json:"country,omitempty"`
	City                  string            `json:"city,omitempty"`
	Technology            string            `json:"technology,omitempty"`
	Protocol              string            `json:"protocol,omitempty"`
	PostQuantum           string            `json:"postQuantum,omitempty"`
	Received              string            `json:"received,omitempty"`
	Sent                  string            `json:"sent,omitempty"`
	Uptime                string            `json:"uptime,omitempty"`
	DefaultRouteInterface string            `json:"defaultRouteInterface,omitempty"`
	Fields                map[string]string `json:"fields,omitempty"`
	Error                 string            `json:"error,omitempty"`
}

type AutomaticUpdates struct {
	Enabled      bool   `json:"enabled"`
	TimerEnabled bool   `json:"timerEnabled"`
	TimerActive  bool   `json:"timerActive"`
	LastRun      string `json:"lastRun,omitempty"`
}
