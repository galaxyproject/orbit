# @galaxyproject/gtn-mcp

An MCP server for the [Galaxy Training Network](https://training.galaxyproject.org): find a
tutorial anywhere in GTN, and find the workflows those tutorials ship.

## Why it indexes

The GTN API has no search endpoint. There is `topics.json`, a payload per topic, and nothing that
spans them. Searching across GTN therefore means reading all ~35 topics — about 26MB — which is
far too much to pull for one query. So this server pulls once, projects every material down to
the fields a search actually reads, and keeps the result: roughly 1MB covering 629 tutorials and
413 workflows.

The first search builds that index (a few seconds). Later searches are local and instant. The
index is refreshed when it is a day old. If GTN is unreachable and a stale index exists, the
stale one is served rather than failing — yesterday's tutorials beat an error.

## Tools

### `gtn_find_tutorial`

Ranked search over every GTN tutorial. Takes `query` in plain words, plus optional `topic`,
`tool` (a Galaxy tool id or fragment), `server` (a Galaxy server URL), `has_workflow` and `limit`.

Every query word must match somewhere, which keeps results tight. When nothing matches all of
them the search relaxes rather than returning empty, and says so with `relaxed: true`.

### `gtn_find_workflow`

The same search, returning the workflows attached to the matching tutorials. Each result carries
`ga_url` (the workflow file, importable into Galaxy), `trs_endpoint` (the same descriptor over
GA4GH TRS) and `tested`, which marks the workflows GTN covers in CI. `tests_only` filters to
those.

These are _teaching_ workflows — each comes with the tutorial that explains it. For production
workflows, search the [IWC](https://iwc.galaxyproject.org) registry instead.

## Running it

```jsonc
{
  "mcpServers": {
    "gtn": { "command": "npx", "args": ["-y", "@galaxyproject/gtn-mcp"] },
  },
}
```

`GTN_MCP_CACHE_DIR` overrides where the index is cached; the default is the usual per-user cache
directory. `gtn-mcp --build-index` builds it up front instead of on first search.

## Notes

The server speaks MCP over stdio directly rather than through the SDK: it answers four methods
and holds no session state, so a dependency would cost more than it saves.

Orbit itself does **not** run this server. It calls the same search in-process (see
`extensions/orbit/tools.ts`), because Orbit's browser and web shells cannot spawn a subprocess
and the in-process path works in all three. Both sit on one implementation in `shared/gtn-index.js`.

That shared import is by relative path, so this package is not yet publishable as it stands —
publishing needs a step that copies `shared/gtn-index.js` and `shared/gtn-index-cache.js` into
the package. That is deliberately left undone until someone wants it on npm.
