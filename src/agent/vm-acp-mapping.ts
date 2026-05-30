// ACP-over-tcp.hosts + synthetic-DNS mapping builder (design §4.2 option A).
//
// Gondolin blocks guest→host loopback by default. The supported rewire for the ACP
// control channel is a `tcp.hosts` mapping: the guest dials a UNIQUE synthetic
// hostname on a fixed port; Gondolin's synthetic per-host DNS resolves that name to
// a mappable IP, and the `tcp.hosts` entry tunnels the flow to the host bridge's
// loopback `HOST:PORT`. The per-dispatch bearer (acp-bridge.ts) still gates auth.
//
// This is RAW mapped TCP — outside the §2 TLS-MITM / secret-substitution path — so
// it carries only our one-shot bridge bearer, never an upstream secret. The mapping
// is PORT-SPECIFIC (not a wildcard) so the channel can never be reused to reach a
// real upstream or a refresh endpoint, and a NEGATIVE test (no other host-loopback
// service is reachable) backs that (design §7 A-3 / spike a3-acp-tcp-bridge.mjs).
//
// Pure + dependency-free so it unit-tests without a VM.

import type { DnsOptions, TcpOptions } from '@earendil-works/gondolin';

/** The synthetic guest hostname the in-VM agent dials for the ACP bridge. */
export const ACP_SYNTHETIC_HOST = 'symphony-acp-bridge';
/**
 * The fixed guest-side port the synthetic name is reached on. Arbitrary — the
 * `tcp.hosts` key is `host:port` and Gondolin matches the guest's dialled port
 * against it, then connects to the mapped upstream `HOST:PORT` (the real bridge port,
 * which differs and is ephemeral). Kept stable so `SYMPHONY_ACP_URL` is deterministic.
 */
export const ACP_GUEST_PORT = 7000;

/** Pure result of {@link buildAcpTcpDns}: the VM config + the URL the guest dials. */
export interface AcpTcpDns {
  /** `tcp.hosts` mapping: `"<syntheticName>:<guestPort>" -> "<bridgeHost>:<bridgePort>"`. */
  tcp: TcpOptions;
  /** Synthetic per-host DNS so the mapped name resolves to a mappable IP. */
  dns: DnsOptions;
  /** What `SYMPHONY_ACP_URL` should be set to (the mapped name + guest port). */
  acpUrl: string;
}

/**
 * Build the `tcp.hosts` + synthetic-DNS config that wires the in-VM ACP agent to the
 * host bridge. The guest dials `tcp://<syntheticName>:<guestPort>`; Gondolin resolves
 * the name via synthetic per-host DNS and tunnels the matched flow to the host bridge
 * loopback `bridgeHost:bridgePort`.
 *
 * The `tcp.hosts` shape (gondolin `TcpOptions`) is `{ hosts: Record<string, string> }`
 * where each key is the guest `host[:port]` to match and each value is the upstream
 * `host:port` to connect to — proven by spike `a3-acp-tcp-bridge.mjs`:
 *   `tcp: { hosts: { 'bridge:7000': '127.0.0.1:<bridge.port>' } }`
 *   `dns: { mode: 'synthetic', syntheticHostMapping: 'per-host' }`
 *
 * `syntheticName` defaults to {@link ACP_SYNTHETIC_HOST}; pass a unique value if a
 * future design runs more than one mapped TCP channel per VM.
 */
export function buildAcpTcpDns(
  bridgeHost: string,
  bridgePort: number,
  syntheticName: string = ACP_SYNTHETIC_HOST,
): AcpTcpDns {
  const guestKey = `${syntheticName}:${ACP_GUEST_PORT}`;
  return {
    tcp: { hosts: { [guestKey]: `${bridgeHost}:${bridgePort}` } },
    dns: { mode: 'synthetic', syntheticHostMapping: 'per-host' },
    acpUrl: `tcp://${syntheticName}:${ACP_GUEST_PORT}`,
  };
}

/** The synthetic guest hostname the in-VM agent dials for the MCP control plane. */
export const MCP_SYNTHETIC_HOST = 'symphony-mcp';
/**
 * The fixed guest-side port the MCP synthetic name is reached on. Distinct from
 * {@link ACP_GUEST_PORT} so the two mapped channels never collide in `tcp.hosts`.
 */
export const MCP_GUEST_PORT = 7001;

/** Guest-facing base URL the in-VM agent dials for MCP (the `/api/v1/...` path is appended by the caller). */
export const MCP_GUEST_BASE_URL = `http://${MCP_SYNTHETIC_HOST}:${MCP_GUEST_PORT}`;

/**
 * Build the `tcp.hosts` entry that tunnels the in-VM agent's MCP control-plane
 * HTTP requests (`symphony.transition` / `propose_issue` / steering) to the host's
 * orchestrator HTTP server on its loopback `mcpHost:mcpPort`. Same mechanism +
 * security posture as {@link buildAcpTcpDns}: Gondolin blocks guest→host loopback,
 * so without this mapping the agent can run inference turns but CANNOT reach the
 * control plane (it could complete work but never transition state). The channel
 * carries only the per-dispatch MCP bearer (the URL + token is the capability),
 * never an upstream secret, and is PORT-SPECIFIC so it can never be reused to
 * reach another host-loopback service. Merge the returned entry into the same
 * `tcp.hosts` record the ACP mapping uses; the synthetic per-host DNS already
 * resolves any synthetic name, so no extra DNS config is needed.
 */
export function buildMcpTcpHostEntry(mcpHost: string, mcpPort: number): Record<string, string> {
  return { [`${MCP_SYNTHETIC_HOST}:${MCP_GUEST_PORT}`]: `${mcpHost}:${mcpPort}` };
}
