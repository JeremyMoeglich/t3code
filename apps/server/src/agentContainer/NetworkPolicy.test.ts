import { assert, describe, it } from "@effect/vitest";

import { parseNetworkPolicy, renderNftables } from "./NetworkPolicy.ts";

describe("NetworkPolicy", () => {
  it("canonicalizes broad-to-narrow rules", () => {
    const policy = parseNetworkPolicy(`
      allow 10.0.0.0/16
      deny 10.0.8.0/24
      allow 10.0.8.5 tcp 80,443,8000-8100
      allow dns tcp,udp 53
    `);
    assert.equal(
      policy.text,
      "allow 10.0.0.0/16\ndeny 10.0.8.0/24\nallow 10.0.8.5/32 tcp 80,443,8000-8100\nallow dns tcp,udp 53",
    );
  });

  it("rejects broader and partially overlapping lower rules", () => {
    assert.throws(
      () => parseNetworkPolicy("deny 10.0.8.0/24\nallow 10.0.0.0/16"),
      /fully shadows line 1/,
    );
    assert.throws(
      () => parseNetworkPolicy("allow 10.0.0.0/16 tcp 80-100\ndeny 10.0.0.0/24 tcp 90-110"),
      /partially overlaps line 1/,
    );
  });

  it("renders default-deny input and output chains", () => {
    const script = renderNftables(parseNetworkPolicy("allow 1.1.1.1 tcp 443"));
    assert.include(script, "chain inet t3_policy output");
    assert.include(script, "policy drop");
    assert.include(script, "ip daddr 1.1.1.1/32 tcp dport 443");
    assert.include(script, "input ct mark 1 accept");
  });
});
