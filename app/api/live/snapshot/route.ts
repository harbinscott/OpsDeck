import type { AgentSnapshot, ProviderEnvelope } from "../../../lib/snapshot";
import { loadDashboardConfig } from "../../../lib/dashboard-config";

export const dynamic = "force-dynamic";

function json(payload: ProviderEnvelope, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET() {
  const { configuration, error: configurationError } = await loadDashboardConfig();
  const configuredUrl = process.env.OPSDECK_AGENT_URL?.trim();
  if (!configuredUrl) {
    return json({ mode: "mock", configuration, configurationError });
  }

  const agentUrl = configuredUrl.replace(/\/$/, "");
  const token = process.env.OPSDECK_AGENT_TOKEN?.trim();

  try {
    const response = await fetch(`${agentUrl}/v1/snapshot`, {
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) {
      const detail = response.status === 401
        ? "The agent rejected the configured token."
        : `The agent returned HTTP ${response.status}.`;
      return json({ mode: "unavailable", configuration, configurationError, error: detail });
    }

    const snapshot = await response.json() as AgentSnapshot;
    if (snapshot.schemaVersion !== 1 || !snapshot.host || !snapshot.metrics) {
      return json({ mode: "unavailable", configuration, configurationError, error: "The agent returned an unsupported snapshot." });
    }

    return json({ mode: "live", snapshot, configuration, configurationError });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "The agent did not respond within 12 seconds."
      : "The configured agent could not be reached.";
    return json({ mode: "unavailable", configuration, configurationError, error: message });
  }
}
