# @pipeworx/sec-contracts

Material-contract exhibits from SEC filings — credit agreements, indentures, merger agreements, employment and severance agreements — found by the **clause language inside them**, over SEC EDGAR full-text search. The inverted question `edgar` cannot answer: not "what did Adobe file" but "which credit agreements filed since 2025 contain a change-of-control clause".

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `sec_contracts_search(query, match?, exhibit_type?, form?, since?, until?, company?, sic?, limit?, include_snippets?)` — exhibits (EX-10 / EX-4 / EX-2, or any) whose text contains a phrase. One row per exhibit document: company, CIK, ticker, root form, filing date, exhibit type and the filer's exhibit description, a snippet around the match, the document URL and accession; plus the same rows grouped by filing.
- `sec_contract_text(url | adsh + filename + cik, max_chars?, offset?, find?)` — the exhibit as paged plaintext. `find` jumps to the first occurrence of a phrase ("Change of Control" definition, "Termination Fee").
- `sec_contracts_by_company(company, exhibit_type?, form?, since?, until?, limit?)` — one filer's material contracts newest first, by ticker, name or CIK.

## Auth

Keyless. SEC asks for a descriptive `User-Agent` on every request; the pack sends one.

## Data sources

- <https://efts.sec.gov/LATEST/search-index> — EDGAR full-text search. Indexes every document in a filing from 2001 onward; each hit carries `file_type` (`EX-10.1`, `EX-4.2`, `10-K`…), `file_description`, `adsh`, `ciks`, `sics`, `display_names`.
- <https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{file}> — the exhibit documents themselves.

Things the next person would otherwise rediscover (all measured 2026-08-28):

- **efts has no exhibit-type parameter.** `forms=EX-10` returns zero — `forms` filters the *root* form. Exhibit filtering is client-side on `file_type`, over-fetching 100 documents a page (up to 500 per call). `EX-10(?!\d)` is the prefix test, because `EX-103` exists as a filer typo.
- **No highlights.** The search response carries no snippet. Snippets are produced by reading the first 1.5 MB of each matched exhibit and windowing the first occurrence of the phrase, five documents at a time.
- **A one-sided `dateRange=custom` is ignored.** `startdt` without `enddt` yields an empty filter and 2008 hits. Both ends are always sent.
- **Unquoted words are ANDed** (one `match_phrase` clause each); `OR` between terms works; a double-quoted phrase is exact; `q=*` matches nothing. The by-company tool therefore queries a broad OR of contract words (`agreement OR indenture OR amendment …`) with a `ciks` filter.
- **Archive URLs need the registrant's CIK**, not the accession prefix. Filing-agent accessions (`0001193125-…` = Donnelley) return 503 on the agent-CIK path. Search rows carry the resolved `cik` and `document_url` for this reason.
- **efts's response cache leaks across `sics` / `ciks` / `entityName`.** The endpoint sits behind an API Gateway cache keyed on `q`, the date window, `forms` and `from`/`page` — but not on `sics`, `ciks` or `entityName`. Measured 2026-08-28: a `sics=7372` request returned the unfiltered 10,000-hit result cached seconds earlier for the same `q` and dates, and the reverse leak (an unfiltered request served the software-only set) too. The body's echoed `query` shows which filters actually ran. The pack appends a negated nonsense token to `q` (`-zqfs7372`) whenever one of those filters is set — efts compiles it to a `must_not` that matches nothing (totals verified identical), and the cache key becomes unique per filter set — and re-checks `sic`/`cik` on every row, reporting in `note` if anything was dropped. Any other pack passing `ciks`/`sics` to efts is exposed to the same leak.
- Coverage floor is 2001-01-01; an earlier `since` is clamped and noted in the response.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "sec-contracts": {
      "url": "https://gateway.pipeworx.io/sec-contracts/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/sec-contracts/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/sec_contracts_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"change of control","exhibit_type":"EX-10","since":"2025-01-01","limit":12}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/sec_contracts_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "sec-contracts": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-sec-contracts"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-sec-contracts
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Sec Contracts data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
