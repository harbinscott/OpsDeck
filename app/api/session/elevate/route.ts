import { issueElevationToken, verifyAdministrativeCredential } from "../../../lib/elevation";
import { loadDashboardConfig } from "../../../lib/dashboard-config";

export const dynamic = "force-dynamic";

let attemptWindowStarted = 0;
let failedAttempts = 0;

export async function POST(request: Request) {
  const now = Date.now();
  if (now - attemptWindowStarted > 60_000) { attemptWindowStarted = now; failedAttempts = 0; }
  if (failedAttempts >= 5) return Response.json({ error: "Too many failed attempts. Try again in one minute." }, { status: 429 });
  let username = "";
  let password = "";
  try {
    const body = await request.json() as { username?: unknown; password?: unknown };
    username = typeof body.username === "string" ? body.username.trim() : "";
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!username || username.length > 64 || !password || password.length > 512) {
    return Response.json({ error: "Enter a valid Linux username and password." }, { status: 400 });
  }

  let authenticatedUsername = username;
  let authenticated = false;
  if (process.env.OPSDECK_AUTH_PROVIDER?.trim().toLowerCase() === "secret") {
    authenticated = verifyAdministrativeCredential(password);
  } else {
    const agentUrl = process.env.OPSDECK_AGENT_URL?.trim().replace(/\/$/, "");
    const token = process.env.OPSDECK_AGENT_TOKEN?.trim();
    if (!agentUrl || !token) {
      password = "";
      return Response.json({ error: "PAM authentication is unavailable because the live agent is not configured." }, { status: 503 });
    }
    try {
      const response = await fetch(`${agentUrl}/v1/auth/elevate`, {
        method: "POST",
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(16_000),
      });
      password = "";
      if (response.ok) {
        const result = await response.json() as { authenticated?: unknown; username?: unknown };
        authenticated = result.authenticated === true;
        if (typeof result.username === "string" && result.username) authenticatedUsername = result.username;
      } else if (response.status >= 500) {
        return Response.json({ error: "Linux authentication is temporarily unavailable." }, { status: 503 });
      }
    } catch {
      password = "";
      return Response.json({ error: "The dashboard could not reach the Linux authentication service." }, { status: 503 });
    }
  }
  password = "";
  if (!authenticated) {
    failedAttempts++;
    await new Promise((resolve) => setTimeout(resolve, 350));
    return Response.json({ error: "The credentials were not accepted or the account is not authorized." }, { status: 401 });
  }
  failedAttempts = 0;
  const { configuration } = await loadDashboardConfig();
  return Response.json(issueElevationToken(authenticatedUsername, configuration.settings?.elevationTimeoutSeconds), { headers: { "Cache-Control": "no-store" } });
}
