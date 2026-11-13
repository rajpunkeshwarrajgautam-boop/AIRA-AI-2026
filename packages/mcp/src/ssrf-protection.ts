import dns from 'node:dns/promises';
import net from 'node:net';

export class McpSecurityError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'MCP_SECURITY_VIOLATION', statusCode = 403) {
    super(message);
    this.name = 'McpSecurityError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Cloud provider metadata hostnames and IP endpoints.
 */
const FORBIDDEN_METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.internal',
  'instance-data',
  'metadata.tencentyun.com',
  '169.254.169.254',
  '100.100.100.200'
]);

/**
 * Convert integer, octal, hex, or decimal IP representation into canonical dot-decimal IPv4 string if possible.
 */
export function normalizeIpCandidate(host: string): string | null {
  const trimmed = host.trim().replace(/^\[|\]$/g, '');

  // 1. Direct standard IPv4 or IPv6
  if (net.isIP(trimmed)) {
    return trimmed;
  }

  // 2. Integer format (e.g. 2130706433 -> 127.0.0.1)
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isNaN(num) && num >= 0 && num <= 4294967295) {
      const b1 = (num >>> 24) & 255;
      const b2 = (num >>> 16) & 255;
      const b3 = (num >>> 8) & 255;
      const b4 = num & 255;
      return `${b1}.${b2}.${b3}.${b4}`;
    }
  }

  // 3. Hex format (e.g. 0x7f000001 -> 127.0.0.1)
  if (/^0x[0-9a-fA-F]+$/i.test(trimmed)) {
    const num = parseInt(trimmed, 16);
    if (!Number.isNaN(num) && num >= 0 && num <= 4294967295) {
      const b1 = (num >>> 24) & 255;
      const b2 = (num >>> 16) & 255;
      const b3 = (num >>> 8) & 255;
      const b4 = num & 255;
      return `${b1}.${b2}.${b3}.${b4}`;
    }
  }

  // 4. Dot-separated octal/hex/decimal parts (e.g. 0177.0.0.1 or 0x7f.0.0.1)
  const parts = trimmed.split('.');
  if (parts.length === 4) {
    const octets: number[] = [];
    for (const part of parts) {
      let val: number;
      if (/^0x[0-9a-fA-F]+$/i.test(part)) {
        val = parseInt(part, 16);
      } else if (/^0[0-7]+$/.test(part)) {
        val = parseInt(part, 8);
      } else if (/^\d+$/.test(part)) {
        val = parseInt(part, 10);
      } else {
        return null;
      }
      if (Number.isNaN(val) || val < 0 || val > 255) {
        return null;
      }
      octets.push(val);
    }
    return octets.join('.');
  }

  return null;
}

/**
 * Evaluates whether an IPv4 address is in a private, loopback, link-local,
 * multicast, or reserved range.
 */
export function isPrivateOrRestrictedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(p => parseInt(p, 10));
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // Treat invalid as restricted
  }

  const [b0, b1] = parts;

  // 0.0.0.0/8 (Current network)
  if (b0 === 0) return true;

  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;

  // 10.0.0.0/8 (RFC 1918 Private)
  if (b0 === 10) return true;

  // 172.16.0.0/12 (RFC 1918 Private: 172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

  // 192.168.0.0/16 (RFC 1918 Private)
  if (b0 === 192 && b1 === 168) return true;

  // 169.254.0.0/16 (Link-Local & Cloud Metadata e.g. 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true;

  // 100.64.0.0/10 (Carrier-Grade NAT: 100.64.0.0 - 100.127.255.255)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (Documentation / TEST-NET)
  if (b0 === 192 && b1 === 0 && parts[2] === 2) return true;
  if (b0 === 198 && b1 === 51 && parts[2] === 100) return true;
  if (b0 === 203 && b1 === 0 && parts[2] === 113) return true;

  // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
  if (b0 >= 224 && b0 <= 239) return true;

  // 240.0.0.0/4 (Reserved for Future Use)
  if (b0 >= 240) return true;

  return false;
}

/**
 * Evaluates whether an IPv6 address is in a private, loopback, link-local,
 * or mapped IPv4 restricted range.
 */
export function isPrivateOrRestrictedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // Loopback ::1
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  // Unspecified ::
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;

  // IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1)
  const mappedMatch = normalized.match(/^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch) {
    return isPrivateOrRestrictedIpv4(mappedMatch[1]);
  }
  if (normalized.startsWith('::ffff:')) {
    // Hex encoded mapped IPv4 (e.g. ::ffff:7f00:1)
    const suffix = normalized.slice(7);
    const hexParts = suffix.split(':');
    if (hexParts.length === 2) {
      const h1 = parseInt(hexParts[0], 16);
      const h2 = parseInt(hexParts[1], 16);
      if (!Number.isNaN(h1) && !Number.isNaN(h2)) {
        const b0 = (h1 >> 8) & 255;
        const b1 = h1 & 255;
        const b2 = (h2 >> 8) & 255;
        const b3 = h2 & 255;
        return isPrivateOrRestrictedIpv4(`${b0}.${b1}.${b2}.${b3}`);
      }
    }
  }

  // Unique Local (fc00::/7 -> fc00:: to fdff::)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // Link-Local (fe80::/10 -> fe80:: to febf::)
  if (/^fe[89ab]/.test(normalized)) return true;

  // Multicast (ff00::/8)
  if (normalized.startsWith('ff')) return true;

  // Documentation (2001:db8::/32)
  if (normalized.startsWith('2001:db8') || normalized.startsWith('2001:0db8')) return true;

  return false;
}

export function isRestrictedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    return isPrivateOrRestrictedIpv4(ip);
  }
  if (version === 6) {
    return isPrivateOrRestrictedIpv6(ip);
  }
  return true;
}

export interface McpUrlValidationOptions {
  allowLocalInDev?: boolean;
}

/**
 * Validates an MCP connection URL against comprehensive SSRF boundaries:
 * 1. Protocol must be http: or https: (in production, only https: unless explicitly overridden).
 * 2. Hostname cannot match known cloud metadata endpoints.
 * 3. Numeric / hex / octal IP representations are normalized and checked.
 * 4. DNS resolution verifies all A and AAAA records do not point to private/restricted addresses.
 */
export async function validateMcpUrl(
  urlString: string,
  options: McpUrlValidationOptions = {}
): Promise<{ safeUrl: URL; resolvedIps: string[] }> {
  if (!urlString || typeof urlString !== 'string') {
    throw new McpSecurityError('MCP server URL is required and must be a valid string', 'INVALID_URL', 400);
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString.trim());
  } catch {
    throw new McpSecurityError(`Malformed MCP URL: ${urlString}`, 'MALFORMED_URL', 400);
  }

  // Protocol check
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpSecurityError(
      `Forbidden protocol '${parsed.protocol}'. Only http and https MCP transports are permitted.`,
      'FORBIDDEN_PROTOCOL',
      400
    );
  }

  // In production, require https unless local dev is explicitly enabled
  const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  const allowLocal = options.allowLocalInDev || process.env.AIRA_ALLOW_LOCAL_MCP === 'true';

  const hostname = parsed.hostname.toLowerCase().trim();

  // Reject cloud metadata hostnames immediately
  if (
    FORBIDDEN_METADATA_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local')
  ) {
    throw new McpSecurityError(
      `Access to internal or cloud metadata destination '${hostname}' is strictly forbidden.`,
      'SSRF_METADATA_PROHIBITED',
      403
    );
  }

  // Check if hostname is an IP candidate (including hex/octal/dword)
  const normalizedDirectIp = normalizeIpCandidate(hostname);
  if (normalizedDirectIp) {
    if (isRestrictedIp(normalizedDirectIp)) {
      if (isProd || !allowLocal) {
        throw new McpSecurityError(
          `Destination IP '${normalizedDirectIp}' resides in a private, loopback, or cloud metadata network.`,
          'SSRF_PRIVATE_IP_PROHIBITED',
          403
        );
      }
    }
    return { safeUrl: parsed, resolvedIps: [normalizedDirectIp] };
  }

  // Localhost hostname check
  if (hostname === 'localhost' || hostname === 'localhost.localdomain') {
    if (isProd && !allowLocal) {
      throw new McpSecurityError(
        'Connecting to localhost MCP endpoints is forbidden in production environments.',
        'SSRF_LOCALHOST_PROHIBITED',
        403
      );
    }
    return { safeUrl: parsed, resolvedIps: ['127.0.0.1'] };
  }

  // DNS Resolution & Rebinding Check
  try {
    const resolved = await dns.lookup(hostname, { all: true });
    if (!resolved || resolved.length === 0) {
      throw new McpSecurityError(`Unable to resolve host: ${hostname}`, 'DNS_RESOLUTION_FAILED', 400);
    }

    const resolvedIps: string[] = [];
    for (const record of resolved) {
      const ip = record.address;
      resolvedIps.push(ip);
      if (isRestrictedIp(ip)) {
        if (isProd || !allowLocal) {
          throw new McpSecurityError(
            `Destination '${hostname}' resolves to restricted IP '${ip}' in a private or metadata range.`,
            'SSRF_DNS_REBINDING_BLOCKED',
            403
          );
        }
      }
    }

    return { safeUrl: parsed, resolvedIps };
  } catch (err: any) {
    if (err instanceof McpSecurityError) throw err;
    throw new McpSecurityError(
      `DNS validation failed for MCP host '${hostname}': ${err.message}`,
      'DNS_LOOKUP_ERROR',
      400
    );
  }
}
