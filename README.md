# PAP RSS Extractor

TypeScript script that fetches configurable PAP.pl category pages, extracts article links, and writes RSS 2.0 feeds.

## Usage

```sh
npm install
npm run --silent rss > pap-all.xml
```

By default, `rss` fetches all configured feeds and outputs one merged RSS (deduplicated by article URL). Feeds are fetched sequentially through Browserless with a 100ms delay between sources, and each source is retried up to 3 times if it fails.

```sh
npm run --silent rss > pap-all.xml
```

Generate separate files for each selected feed (or all feeds if `--feeds` is not provided):

```sh
npm run rss:separate
```

Browserless requires `BROWSERLESS_API_KEY` in `.env.local` for local runs:

```sh
BROWSERLESS_API_KEY=your_browserless_key
```

The default endpoint is `https://production-sfo.browserless.io/content`. Override it with `BROWSERLESS_CONTENT_ENDPOINT` if needed.

## GitHub Actions

The scheduled workflow in `.github/workflows/refresh-rss.yml` runs every 6 hours and on demand. It:

1. Fetches each configured page separately.
2. Writes per-feed XML files under `feeds/batches/{timestamp}/separate/`.
3. Writes the merged feed to `feeds/batches/{timestamp}/merged.xml`.
4. Copies the latest merged feed to `rss.xml` in the repository root.
5. Commits and pushes `feeds/` and `rss.xml`.

Add `BROWSERLESS_API_KEY` as a repository secret. Optionally set `BROWSERLESS_CONTENT_ENDPOINT` as a repository variable.

## GitHub Pages

Enable GitHub Pages for the repository from the default branch and the root directory. The public merged feed is served from:

```text
https://<user>.github.io/<repo>/rss.xml
```

Historical batches remain in `feeds/batches/`.

## CLI options

Merge only selected slugs:

```sh
npm run --silent rss -- --feeds kultura,sport > pap-kultura-sport.xml
```

Write selected slugs as separate files:

```sh
npm run rss -- --separate --feeds kultura,sport
```

You can pass a one-off URL (requires exactly one selected slug):

```sh
npm run rss -- --feeds gospodarka https://www.pap.pl/gospodarka
```

The feed list is configured in `config/pap-feeds.json`. Each entry has:

```json
{
  "slug": "gospodarka",
  "title": "PAP.pl - Gospodarka",
  "url": "https://www.pap.pl/gospodarka",
  "description": "Najnowsze artykuly z dzialu Gospodarka w serwisie PAP.pl"
}
```

Use a different config or output directory:

```sh
npm run rss -- --separate --config config/other-feeds.json --out-dir custom-feeds
```

Run a one-off refresh locally:

```sh
npm run refresh
```

Run the type checker:

```sh
npm run check
```

If PAP returns its Incapsula protection page instead of the category HTML, that source is retried up to 3 times. The merged feed skips sources that still fail and exits only if no articles can be fetched.
