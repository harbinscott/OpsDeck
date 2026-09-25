import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

type ElevationClaims = { exp: number; nonce: string; username: string };

function sessionSecret() {
  const secret = process.env.OPSDECK_SESSION_SECRET?.trim();
  if (!secret) throw new Error("OPSDECK_SESSION_SECRET is not configured.");
  return secret;
}

function signature(payload: string) {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export function elevationTimeoutSeconds() {
  const configured = Number(process.env.OPSDECK_ELEVATION_TIMEOUT_SECONDS ?? 900);
  return Math.min(3600, Math.max(60, Number.isFinite(configured) ? Math.floor(configured) : 900));
}

export function verifyAdministrativeCredential(provided: string) {
  const expected = process.env.OPSDECK_ADMIN_SECRET?.trim() ?? "";
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return expected.length >= 32 && left.length === right.length && timingSafeEqual(left, right);
}

export function issueElevationToken(username: string, configuredTimeoutSeconds?: number) {
  const timeout = configuredTimeoutSeconds == null
    ? elevationTimeoutSeconds()
    : Math.min(3600, Math.max(60, Math.floor(configuredTimeoutSeconds)));
  const expiresAt = Date.now() + timeout * 1000;
  const claims: ElevationClaims = { exp: expiresAt, nonce: randomBytes(16).toString("hex"), username };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { token: `${payload}.${signature(payload)}`, expiresAt, username };
}

export function elevationClaims(request: Request): ElevationClaims | null {
  const prefix = "OpsDeck-Elevation ";
  const authorization = request.headers.get("authorization") ?? "";
	if (!authorization.startsWith(prefix)) return null;
  const token = authorization.slice(prefix.length);
  const separator = token.indexOf(".");
	if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  const expectedSignature = signature(payload);
  const left = Buffer.from(providedSignature);
  const right = Buffer.from(expectedSignature);
	if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ElevationClaims;
		return typeof claims.exp === "number" && claims.exp > Date.now() && typeof claims.nonce === "string" && typeof claims.username === "string" && claims.username.length > 0 ? claims : null;
	} catch {
		return null;
	}
}

export function isElevated(request: Request) { return elevationClaims(request) !== null; }
