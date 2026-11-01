# What's Happening

Tells the user, in plain words and as it happens, what their assistant is
doing in their Galaxy: one group per message, a live status line that is
never blank while work is going on, a row for each change to their Galaxy
(with links to the jobs, datasets and histories it touched), and when it is
waiting on them. In Orbit it is the "What's Happening" tab of the right pane.

`core/` is harness-agnostic: it imports nothing from Orbit, pi or the DOM,
only `@galaxyproject/galaxy-ops` (its browser entry), so any harness that
talks to Galaxy through the Galaxy MCP can use it.

```
whats-happening/
└── core/
    ├── types.ts     events in (tool calls, lifecycle), the state out
    ├── narrator.ts  advance(): folds events into the state; currentStatus()
    ├── catalog.ts   what each tool call means (change / look / wait / internal) and its title
    ├── results.ts   reads a call's galaxy-ops envelope: jobs started, items produced, failure reason
    ├── names.ts     names of tools, datasets and histories learned from results
    ├── refs.ts      builds the refs (GalaxyRef) to Galaxy objects
    └── rows.ts      arranges a group as changes, each with the reads and checks done for it
```

## Using the core

1. Turn the harness's events into `NarrationEvent`s: tool calls as
   `ToolEvent` (`start` / `end`, with the call's arguments and its galaxy-ops
   envelope as the result), and lifecycle events (`group-start`,
   `group-end`, `model`, `awaiting-user`, `job-state`, …). Each group's
   events carry its `groupId` (one per message, background check, subagent,
   …), so groups can run side by side; each ends on its own `group-end`.
2. Fold them in with `advance(state, event)`, starting from `EMPTY_STATE`.
   It is pure and returns the same state when nothing changed.
3. Draw `state.groups`, plus what is happening now:
   - `currentActivity(state)`: everything going on at once.
   - `currentStatus(state)`: one line, when there is room for only one.
4. To show the work done for a user's message, put the message's id on its
   `group-message` event. For the harness's own follow-ups, also say which
   Galaxy jobs they are about. Everything done for a message, follow-ups
   included, can then be shown with that message.
5. Send each Galaxy job's and workflow run's state as a `job-state` event,
   from the harness's own poller, so rows stay "running" until Galaxy says
   they are done.

Tests: `tests/narration-core.test.ts`.
