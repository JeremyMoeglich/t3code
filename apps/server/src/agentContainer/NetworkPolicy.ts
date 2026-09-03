// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";

export type NetworkAction = "allow" | "deny";
export type NetworkProtocol = "tcp" | "udp" | "icmp";

interface PortRange {
  readonly from: number;
  readonly to: number;
}

interface IpTarget {
  readonly kind: "ip";
  readonly family: 4 | 6;
  readonly prefix: number;
  readonly network: bigint;
  readonly end: bigint;
  readonly text: string;
}

interface DnsTarget {
  readonly kind: "dns";
}

export interface NetworkRule {
  readonly action: NetworkAction;
  readonly target: IpTarget | DnsTarget;
  readonly protocols: ReadonlyArray<NetworkProtocol> | undefined;
  readonly ports: ReadonlyArray<PortRange> | undefined;
  readonly line: number;
  readonly text: string;
}

export interface NetworkPolicy {
  readonly rules: ReadonlyArray<NetworkRule>;
  readonly text: string;
}

interface LogicalRule {
  readonly rule: NetworkRule;
  readonly target: IpTarget;
  readonly protocol: NetworkProtocol | undefined;
}

const PROTOCOL_ORDER: ReadonlyArray<NetworkProtocol> = ["tcp", "udp", "icmp"];

function fail(source: string, line: number, message: string): never {
  throw new Error(`${source}:${line}: ${message}`);
}

function parseIpv4(address: string): bigint {
  const parts = address.split(".");
  if (parts.length !== 4) throw new Error("invalid IPv4 address");
  let value = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) throw new Error("invalid IPv4 address");
    const octet = Number(part);
    if (octet < 0 || octet > 255) throw new Error("invalid IPv4 address");
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6Side(side: string): ReadonlyArray<number> {
  if (!side) return [];
  const tokens = side.split(":");
  const values: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!token) throw new Error("invalid IPv6 address");
    if (token.includes(".")) {
      if (index !== tokens.length - 1) throw new Error("embedded IPv4 address must be last");
      const ipv4 = parseIpv4(token);
      values.push(Number((ipv4 >> 16n) & 0xffffn), Number(ipv4 & 0xffffn));
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(token)) throw new Error("invalid IPv6 address");
    values.push(Number.parseInt(token, 16));
  }
  return values;
}

function parseIpv6(address: string): bigint {
  if (address.includes("%")) throw new Error("IPv6 zone identifiers are not supported");
  const compressed = address.indexOf("::");
  if (compressed !== -1 && compressed !== address.lastIndexOf("::")) {
    throw new Error("invalid IPv6 address");
  }
  const left = parseIpv6Side(compressed === -1 ? address : address.slice(0, compressed));
  const right = compressed === -1 ? [] : parseIpv6Side(address.slice(compressed + 2));
  const missing = 8 - left.length - right.length;
  const groups =
    compressed === -1 ? left : [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if ((compressed === -1 && groups.length !== 8) || (compressed !== -1 && missing < 1)) {
    throw new Error("invalid IPv6 address");
  }
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join(".");
}

function formatIpv6(value: bigint): string {
  const groups: string[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(((value >> shift) & 0xffffn).toString(16));
  }
  return groups.join(":");
}

function parseTarget(value: string): IpTarget {
  const slash = value.indexOf("/");
  if (slash !== -1 && slash !== value.lastIndexOf("/")) throw new Error("invalid CIDR");
  const address = slash === -1 ? value : value.slice(0, slash);
  const family = NodeNet.isIP(address);
  if (family !== 4 && family !== 6) throw new Error("expected an IP address, CIDR, or dns");
  const bits = family === 4 ? 32 : 128;
  const prefixText = slash === -1 ? String(bits) : value.slice(slash + 1);
  if (!/^\d+$/.test(prefixText)) throw new Error("invalid CIDR prefix");
  const prefix = Number(prefixText);
  if (prefix < 0 || prefix > bits) throw new Error(`CIDR prefix must be between 0 and ${bits}`);
  const addressValue = family === 4 ? parseIpv4(address) : parseIpv6(address);
  const hostBits = BigInt(bits - prefix);
  const hostMask = hostBits === 0n ? 0n : (1n << hostBits) - 1n;
  const allBits = (1n << BigInt(bits)) - 1n;
  const network = addressValue & (allBits ^ hostMask);
  return {
    kind: "ip",
    family,
    prefix,
    network,
    end: network | hostMask,
    text: `${family === 4 ? formatIpv4(network) : formatIpv6(network)}/${prefix}`,
  };
}

function parseProtocols(
  value: string,
  source: string,
  line: number,
): ReadonlyArray<NetworkProtocol> {
  const values = value.split(",");
  const unique = new Set<NetworkProtocol>();
  for (const item of values) {
    if (item !== "tcp" && item !== "udp" && item !== "icmp") {
      fail(source, line, `unsupported protocol ${JSON.stringify(item)}`);
    }
    if (unique.has(item)) fail(source, line, `duplicate protocol ${item}`);
    unique.add(item);
  }
  return PROTOCOL_ORDER.filter((protocol) => unique.has(protocol));
}

function parsePorts(value: string, source: string, line: number): ReadonlyArray<PortRange> {
  const ranges = value.split(",").map((item) => {
    const match = /^(\d+)(?:-(\d+))?$/.exec(item);
    if (!match) return fail(source, line, `invalid port or port range ${JSON.stringify(item)}`);
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (from < 1 || from > 65_535 || to < 1 || to > 65_535 || from > to) {
      return fail(source, line, `invalid port range ${JSON.stringify(item)}`);
    }
    return { from, to };
  });
  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  const normalized: PortRange[] = [];
  for (const range of ranges) {
    const previous = normalized.at(-1);
    if (previous && range.from <= previous.to) fail(source, line, "port ranges must not overlap");
    if (previous && range.from === previous.to + 1) {
      normalized[normalized.length - 1] = { from: previous.from, to: range.to };
    } else normalized.push(range);
  }
  return normalized;
}

function canonicalRule(rule: Omit<NetworkRule, "text">): string {
  const parts: string[] = [rule.action, rule.target.kind === "dns" ? "dns" : rule.target.text];
  if (rule.protocols) parts.push(rule.protocols.join(","));
  if (rule.ports) {
    parts.push(
      rule.ports.map(({ from, to }) => (from === to ? `${from}` : `${from}-${to}`)).join(","),
    );
  }
  return parts.join(" ");
}

function targetContains(container: IpTarget, candidate: IpTarget): boolean {
  return (
    container.family === candidate.family &&
    container.network <= candidate.network &&
    container.end >= candidate.end
  );
}

function protocolsOverlap(left: LogicalRule, right: LogicalRule): boolean {
  return (
    left.protocol === undefined || right.protocol === undefined || left.protocol === right.protocol
  );
}

function portsOverlap(left: LogicalRule, right: LogicalRule): boolean {
  if (!protocolsOverlap(left, right)) return false;
  if (
    left.protocol === undefined ||
    right.protocol === undefined ||
    left.protocol === "icmp" ||
    right.protocol === "icmp"
  )
    return true;
  if (!left.rule.ports || !right.rule.ports) return true;
  return left.rule.ports.some((a) =>
    right.rule.ports!.some((b) => a.from <= b.to && b.from <= a.to),
  );
}

function portsContain(container: LogicalRule, candidate: LogicalRule): boolean {
  if (container.protocol === undefined) return true;
  if (candidate.protocol === undefined || container.protocol !== candidate.protocol) return false;
  if (container.protocol === "icmp" || !container.rule.ports) return true;
  if (!candidate.rule.ports) return false;
  return candidate.rule.ports.every((wanted) => {
    let cursor = wanted.from;
    for (const available of container.rule.ports!) {
      if (available.to < cursor) continue;
      if (available.from > cursor) return false;
      cursor = available.to + 1;
      if (cursor > wanted.to) return true;
    }
    return false;
  });
}

function logicalRules(rules: ReadonlyArray<NetworkRule>): ReadonlyArray<LogicalRule> {
  const logical: LogicalRule[] = [];
  for (const rule of rules) {
    if (rule.target.kind !== "ip") continue;
    if (rule.protocols) {
      for (const protocol of rule.protocols) {
        logical.push({ rule, target: rule.target, protocol });
      }
    } else logical.push({ rule, target: rule.target, protocol: undefined });
  }
  return logical;
}

function validateHierarchy(rules: ReadonlyArray<NetworkRule>, source: string): void {
  const logical = logicalRules(rules);
  for (let laterIndex = 0; laterIndex < logical.length; laterIndex += 1) {
    const later = logical[laterIndex]!;
    for (let earlierIndex = 0; earlierIndex < laterIndex; earlierIndex += 1) {
      const earlier = logical[earlierIndex]!;
      if (earlier.rule.line === later.rule.line || earlier.target.family !== later.target.family)
        continue;
      const targetOverlap =
        earlier.target.network <= later.target.end && later.target.network <= earlier.target.end;
      if (!targetOverlap || !portsOverlap(earlier, later)) continue;
      const laterContainsEarlier =
        targetContains(later.target, earlier.target) &&
        (later.protocol === undefined || later.protocol === earlier.protocol) &&
        portsContain(later, earlier);
      if (laterContainsEarlier)
        fail(
          source,
          later.rule.line,
          `rule fully shadows line ${earlier.rule.line}; broader rules must come first`,
        );
      const earlierContainsLater =
        targetContains(earlier.target, later.target) &&
        (earlier.protocol === undefined || earlier.protocol === later.protocol) &&
        portsContain(earlier, later);
      if (!earlierContainsLater)
        fail(
          source,
          later.rule.line,
          `rule partially overlaps line ${earlier.rule.line} without being strictly narrower`,
        );
    }
  }
}

export function parseNetworkPolicy(text: string, source = "network policy"): NetworkPolicy {
  const rules: NetworkRule[] = [];
  for (const [index, rawLine] of text.replaceAll("\r\n", "\n").split("\n").entries()) {
    const line = index + 1;
    const content = rawLine
      .slice(0, rawLine.indexOf("#") === -1 ? undefined : rawLine.indexOf("#"))
      .trim();
    if (!content) continue;
    const tokens = content.split(/\s+/);
    if (tokens.length < 2 || tokens.length > 4)
      fail(source, line, "expected: allow|deny TARGET [PROTOCOLS [PORTS]]");
    const action = tokens[0];
    if (action !== "allow" && action !== "deny")
      fail(source, line, "rule must start with allow or deny");
    let target: IpTarget | DnsTarget;
    if (tokens[1] === "dns") target = { kind: "dns" };
    else {
      try {
        target = parseTarget(tokens[1]!);
      } catch (cause) {
        fail(source, line, cause instanceof Error ? cause.message : String(cause));
      }
    }
    const protocols = tokens[2] ? parseProtocols(tokens[2], source, line) : undefined;
    const ports = tokens[3] ? parsePorts(tokens[3], source, line) : undefined;
    if (ports && !protocols) fail(source, line, "ports require explicit tcp or udp protocols");
    if (ports && protocols?.includes("icmp"))
      fail(source, line, "ports cannot be combined with icmp");
    const fields = { action, target, protocols, ports, line } satisfies Omit<NetworkRule, "text">;
    rules.push({ ...fields, text: canonicalRule(fields) });
  }
  validateHierarchy(
    rules.filter((rule) => rule.target.kind === "ip"),
    source,
  );
  return { rules, text: rules.map((rule) => rule.text).join("\n") };
}

export function expandDnsRules(
  policy: NetworkPolicy,
  nameservers: ReadonlyArray<string>,
  source = "network policy",
): NetworkPolicy {
  const targets = [
    ...new Map(
      nameservers.map((address) => {
        const target = parseTarget(address);
        return [target.text, target] as const;
      }),
    ).values(),
  ];
  const rules = policy.rules.flatMap((rule): ReadonlyArray<NetworkRule> => {
    if (rule.target.kind === "ip") return [rule];
    if (targets.length === 0)
      fail(source, rule.line, "dns was used but Podman did not configure a nameserver");
    return targets.map((target) => {
      const fields = { ...rule, target };
      return { ...fields, text: canonicalRule(fields) };
    });
  });
  validateHierarchy(rules, source);
  return { rules, text: rules.map((rule) => rule.text).join("\n") };
}

function renderPorts(ports: ReadonlyArray<PortRange>): string {
  const values = ports.map(({ from, to }) => (from === to ? `${from}` : `${from}-${to}`));
  return values.length === 1 ? values[0]! : `{ ${values.join(", ")} }`;
}

function renderRule(rule: LogicalRule): string {
  const family = rule.target.family === 4 ? "ip" : "ip6";
  const parts = [`${family} daddr ${rule.target.text}`];
  if (rule.protocol === "tcp" || rule.protocol === "udp") {
    parts.push(
      rule.rule.ports
        ? `${rule.protocol} dport ${renderPorts(rule.rule.ports)}`
        : `meta l4proto ${rule.protocol}`,
    );
  } else if (rule.protocol === "icmp") {
    parts.push(rule.target.family === 4 ? "ip protocol icmp" : "meta l4proto ipv6-icmp");
  }
  parts.push(rule.rule.action === "allow" ? "ct mark set 1 accept" : "drop");
  return `add rule inet t3_policy output ${parts.join(" ")}`;
}

export function renderNftables(policy: NetworkPolicy): string {
  return [
    "destroy table inet t3_policy",
    "add table inet t3_policy",
    "add chain inet t3_policy output { type filter hook output priority 0; policy drop; }",
    "add chain inet t3_policy input { type filter hook input priority 0; policy drop; }",
    'add rule inet t3_policy output oifname "lo" accept',
    'add rule inet t3_policy input iifname "lo" accept',
    "add rule inet t3_policy output meta l4proto ipv6-icmp icmpv6 type { nd-router-solicit, nd-neighbor-solicit, nd-neighbor-advert } accept",
    "add rule inet t3_policy input meta l4proto ipv6-icmp icmpv6 type { nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept",
    "add rule inet t3_policy output udp sport 68 udp dport 67 accept",
    "add rule inet t3_policy input udp sport 67 udp dport 68 accept",
    "add rule inet t3_policy output udp sport 546 udp dport 547 accept",
    "add rule inet t3_policy input udp sport 547 udp dport 546 accept",
    ...[...logicalRules(policy.rules)].reverse().map(renderRule),
    "add rule inet t3_policy input ct mark 1 accept",
    "",
  ].join("\n");
}
