# 15 min meeting between Nithin Sudarsan and Tobias Otte

### Top of mind

- Cloud agent planning mode unavailable - major blocker for Tobias’s workflow where he needs to review agent plans before execution
- PR review process broken due to lack of context about agent decisions and intent behind generated code
- Agent collaboration and transparency across team members is fragmented with no unified orchestration layer

### Updates and wins

- Tobias’s current workflow with Claude agents is highly effective for personal productivity
  - Uses cloud agents with full environment setup including automated testing
  - Successfully delegates work during commute with half-written instructions
  - Team of 4 using mix of Cursor, Claude, and Codeium depending on model preferences
- Basegraph has built cross-platform agent continuity that maintains context across Slack, GitHub, and other platforms
  - First company to crack true cross-platform agent persistence using routing engine and graph-based brain
  - Agent maintains same identity and context when switching between platforms

### Challenges and blockers

- Planning mode limitation in cloud agents prevents Tobias from reviewing execution plans before code generation
  - Must run locally in Cursor to create plans, then send to cloud - impossible during commute
- PR review nightmare with 10,000+ line agent-generated code submissions
  - No visibility into agent’s decision-making process or architectural choices
  - Cannot communicate directly with the agent that created the code
- Compliance and security issues around agent approvals
  - No way to formally approve agent-generated changes for audit trail
  - GitHub doesn’t differentiate between human and agent contributions for approval workflows
- Team agent work happens in silos with no shared context or transparency
  - Each team member’s agent interactions are hidden from others
  - No orchestration layer for collaborative agent work

### Mutual feedback

- Tobias expressed skepticism about platform demos reaching production quality
  - Concerned about the typical “90% demo, 10% weirdness” problem
  - Emphasized need for seamless integration rather than platform replacement
- Tobias more interested in agent collaboration features than full platform replacement
  - Values the collaborative transparency layer over UI consolidation
- Highlighted that tool adoption requires entire team buy-in, not just individual users

### Next Milestone

- Basegraph to provide Claude plugin for immediate testing
  - Plugin enables collaboration phase before execution phase
  - Bi-directional communication between Relay agent and Claude
- Platform demo scheduled once prototype ready (estimated 2-3 weeks)
  - Two other companies already committed to migrating from Slack/Linear
  - Native macOS app in development
- Tobias agreed to trial if platform can integrate with existing toolchain without major workflow disruption
  - Emphasized need for team-wide adoption for tool to be valuable
  - Willing to test agent collaboration features specifically
