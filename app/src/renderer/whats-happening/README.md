# What's Happening

Tells the user, in plain words and as it happens, what their assistant is
doing in their Galaxy: one card per message, a live status line that is
never blank while work is going on, a row for each change to their Galaxy
(with links to the jobs, datasets and histories it touched), and when it is
waiting on them. It only tells the Galaxy interaction; the assistant's reply
says the rest.

In Orbit it shows in two places:

- **Under each chat message**: Every time a new message is sent by the user and
  subsequent actions are taken (such as Galaxy jobs being started, Orbit checks
  being performed, or user approvals being requested), a `whats-happening` display
  is stacked on top of the chat input: one line saying where that message's work
  stands ("● Running fastp… · 2m 05s so far", "✅ Done in 6s · 1 change to your
  Galaxy").
  The latest message's line is docked above the chat input, and says when anything
  else is still going on ("⏳ 1 more running ›", which opens Activity).
  Lines for work that never touched Galaxy disappear once it is over.
- **In the Activity tab**, The entire set of all `whats-happening` displays for
  each message is also provided in Orbit's "Activity" tab as a toggle between
  showing it or the web shell (`SHELL`). Each message's work is rendered in
  individual cards within the display, with small, clickable message number badges
  that allow users to quickly navigate to the corresponding message in the chat.

`core/` is harness-agnostic: it imports nothing from Orbit, pi or the DOM,
only `@galaxyproject/galaxy-ops` (its browser entry), so any harness that
talks to Galaxy through the Galaxy MCP can use it. `views/` draws it as
elements (Lit, their one dependency) for any page or webview, whatever
framework the page uses.

```
whats-happening/
├── adapters/
│   └── pi.ts               pi's events into narration events, for harnesses built on pi
├── views/
│   ├── card.ts             shared by the views: the message card, its rows, steps and follow-ups
│   ├── parts.ts            shared by the views: the base element, status lines, styles
│   ├── whats-happening.ts  <whats-happening>: the live status and every message's card
│   └── whats-happening-inline.ts  <whats-happening-inline>: one message's work on one line, opening to its card
└── core/
    ├── types.ts     events in (tool calls, lifecycle), the state out
    ├── narrator.ts  advance(): folds events into the state; currentActivity(), currentStatus()
    ├── catalog.ts   what each tool call means (change / look / wait / internal) and its title
    ├── results.ts   reads a call's galaxy-ops envelope: jobs started, items produced, failure reason
    ├── names.ts     names of tools, workflows, datasets and histories learned from results
    ├── refs.ts      builds the refs (GalaxyRef) to Galaxy objects
    └── rows.ts      arranges a group as changes, each with the reads and checks done for it
```

Orbit's wiring sits beside this folder, in `app/src/renderer/`, since it is
Orbit's, not the feature's:

```
whats-happening-orbit.ts     the narration over Orbit's events, notify messages and files
whats-happening-chat.ts      the line under each chat message, and the docked one
whats-happening-activity.ts  the list in the Activity tab
```

## Using the core

1. Turn the harness's events into `NarrationEvent`s: tool calls as
   `ToolEvent` (`start` / `end`, with the call's arguments and its galaxy-ops
   envelope as the result), and lifecycle events (`group-start`,
   `group-message`, `group-end`, `model`, `job-state`, …). Each group's
   events carry its `groupId` (one per message, background check, subagent,
   …), so groups can run side by side; each ends on its own `group-end`.
   A harness built on pi (like Orbit) gets this from `adapters/pi.ts`:
   `fromPiEvent()` turns each pi event into narration events, starting a new
   group for each message, even one sent while a run is going.
2. Fold them in with `advance(state, event)`, starting from `EMPTY_STATE`.
   It is pure and returns the same state when nothing changed.
3. Draw `state.groups`, plus what is happening now:
   - `currentActivity(state)`: everything going on at once.
   - `currentStatus(state)`: one line, when there is room for only one.
   - `isStalled(line, now)` / `stallText(line)`: when a line has gone quiet, who is slow.
4. To show the work done for a user's message, put the message's id on its
   `group-message` event (`messageId`). For the harness's own follow-ups, also
   say which Galaxy jobs they are about (`about`), and which request they
   answer (`answerId`, e.g. an approved proposal). Everything done for a
   message, follow-ups included, can then be found with
   `groupsForUserMessage(state, messageId)`.
5. Send each Galaxy job's and workflow run's state as a `job-state` event,
   from the harness's own poller, so rows stay "running" until Galaxy says
   they are done; add `progress` when it counts a workflow run's jobs.
6. Optional, when the harness has them:
   - `awaiting-user` / `user-replied`: an approval or question it is waiting
     on, and its answer (each with an `id`, so several can be pending).
   - `run-labeled`: the harness's own label for a run (e.g. the step it
     recorded it under), shown beside the run, never as its name.
   - `galaxy-finished`: the harness saying some work finished, matched loosely
     by its label.

## Using the views

Register the element you use, `defineWhatsHappening()` for the list or
`defineWhatsHappeningInline()` for the one-line view (or both), and set its
`state` after each change.

- `<whats-happening>` shows every message's work.
- `<whats-happening-inline user-message-id="…">` shows one message's work on
  one line, e.g. under its chat bubble. With `hide-if-nothing-happened`, once
  the message's work is over it disappears if the work never touched Galaxy
  or asked the user something, so chat-only replies leave nothing under their
  bubble. With `show-elsewhere`, it also says when anything else is going on,
  as a button that fires `show-activity`, for the host to show the list.

Both optionally take `buildUrl` (links into Galaxy), `assistant-name` (e.g.
"Orbit") and `messageLabel` (the host's label for a message, e.g. its number
in the chat; a card shows it as a button that fires `show-message` with
`{ userMessageId }`). Restyle them with `--wh-*` CSS custom properties.

## In Orbit

`createOrbitNarration()` feeds the core from pi's events (through
`adapters/pi.ts`), Orbit's notify messages (an approval, a finished job, a
paused follow-up) and its files: Galaxy job states from `activity.jsonl`, and
workflow runs' counts from the notebook's invocation blocks. Orbit's own
messages (`[Orbit …]`) become follow-ups on the runs they name, and the run
after `/approve` stays with the message that proposed it.

- **Resuming a session** (desktop): `restore()` rebuilds the cards from the
  session replay the chat redraws from, then reads job states from the whole
  activity log. It is approximate: waits aren't replayed, and timings come
  from the session file.
- **A fresh session** (`/new`, either choice, or another analysis folder):
  `reset()` clears it with the chat.

Known gaps: the web shell (`web/`) has no session replay, so a reload there
empties What's Happening (the brain keeps running); and after `/new` → Keep
notebook, a Galaxy job still going is polled by the new session but no longer
shown.
