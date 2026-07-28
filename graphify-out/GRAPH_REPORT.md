# Graph Report - homebridge-ventair-ceiling-fan  (2026-07-28)

## Corpus Check
- 14 files · ~19,867 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 117 nodes · 116 edges · 11 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `8ebc64ef`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 13 edges
2. `Execution order` - 12 edges
3. `Homebridge Ventair Ceiling Fan — Homebridge v2 Modernisation` - 12 edges
4. `HomebridgeVentairCeilingFan` - 7 edges
5. `Architecture` - 6 edges
6. `scripts` - 5 edges
7. `CeilingFanAccessory` - 5 edges
8. `Homebridge Ventair Ceiling Fan — v2 Modernisation Implementation Plan` - 5 edges
9. `Ventair Skyfan DC Ceiling Fan` - 4 edges
10. `repository` - 3 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (11 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.15
Nodes (12): Acceptance criteria, Config validation, Custom settings UI, Decisions, Deployment and verification, Homebridge Ventair Ceiling Fan — Homebridge v2 Modernisation, HomeKit modelling, Packaging and tooling (+4 more)

### Community 1 - "Community 1"
Cohesion: 0.33
Nodes (6): Architecture, Discovery, `dps.ts` — the keystone, Light support, Reconnect supervision, `tuya/device.ts` — the transport seam

### Community 2 - "Community 2"
Cohesion: 0.10
Nodes (19): bugs, url, dependencies, tuyapi, description, displayName, engines, homebridge (+11 more)

### Community 3 - "Community 3"
Cohesion: 0.12
Nodes (16): Conventions, Execution order, Homebridge Ventair Ceiling Fan — v2 Modernisation Implementation Plan, Measured facts (do not re-derive), Self-review, Task #10: Deploy and verify on the live bridge — one fan, then eight, Task #11: Confirm numeric DP indices over the LAN, Task #12: Adversarial review of the completed work (+8 more)

### Community 4 - "Community 4"
Cohesion: 0.13
Nodes (14): compilerOptions, allowSyntheticDefaultImports, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution (+6 more)

### Community 5 - "Community 5"
Cohesion: 0.22
Nodes (4): DeviceConfig, HomebridgeVentairCeilingFan, CeilingFanAccessory, TuyaDeviceData

### Community 6 - "Community 6"
Cohesion: 0.15
Nodes (13): devDependencies, eslint, @eslint/js, globals, homebridge, nodemon, rimraf, ts-node (+5 more)

### Community 7 - "Community 7"
Cohesion: 0.29
Nodes (5): Architecture, Commands, Config, Connection lifecycle, Tuya DPS mapping

### Community 8 - "Community 8"
Cohesion: 0.33
Nodes (5): Configuration, homebridge-ventair-ceiling-fan, Installation, Thanks, Ventair Skyfan DC Ceiling Fan

### Community 9 - "Community 9"
Cohesion: 0.40
Nodes (5): scripts, build, lint, prepublishOnly, watch

## Knowledge Gaps
- **83 isolated node(s):** `private`, `displayName`, `name`, `version`, `description` (+78 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `devDependencies` connect `Community 6` to `Community 2`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Why does `scripts` connect `Community 9` to `Community 2`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `Homebridge Ventair Ceiling Fan — Homebridge v2 Modernisation` connect `Community 0` to `Community 1`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `private`, `displayName`, `name` to the rest of the system?**
  _83 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.11764705882352941 - nodes in this community are weakly interconnected._
- **Should `Community 4` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._