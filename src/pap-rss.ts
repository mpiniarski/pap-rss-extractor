import { access, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const DEFAULT_CONFIG_PATH = "config/pap-feeds.json";
const DEFAULT_BROWSERLESS_CONTENT_ENDPOINT = "https://production-sfo.browserless.io/content";
const MAX_FEED_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;
const FEED_REQUEST_DELAY_MS = 100;
const BROWSERLESS_RATE_LIMIT_RETRY_MS = 60_000;
export const BATCHES_DIRNAME = "batches";
export const FINISHED_MERGED_FILENAME = "merged.xml";
export const SEPARATE_FEED_DIRNAME = "separate";
export const PUBLIC_MERGED_FEED_PATH = "rss.xml";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type Article = {
  title: string;
  link: string;
  description?: string;
  pubDate?: string;
  source?: ArticleSource;
};

type ArticleSource = {
  title: string;
  url: string;
};

type FeedDefinition = {
  slug: string;
  title: string;
  url: string;
  description?: string;
};

type QueryParams = Record<string, string>;
type RequestHeaders = Record<string, string>;

type FeedResult =
  | {
      feed: FeedDefinition;
      articles: Article[];
    }
  | {
      feed: FeedDefinition;
      error: string;
    };

export type FeedConfig = {
  outputDir: string;
  requestQueryParams?: QueryParams;
  feeds: FeedDefinition[];
};

type CliOptions = {
  configPath: string;
  outputDir?: string;
  selectedSlugs?: string[];
  separate: boolean;
  sourceUrl?: string;
};

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    configPath: DEFAULT_CONFIG_PATH,
    separate: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--config") {
      options.configPath = getRequiredArgValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--out-dir") {
      options.outputDir = getRequiredArgValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--feeds") {
      const slugs = getRequiredArgValue(args, (index += 1), arg)
        .split(",")
        .map((slug) => slug.trim())
        .filter(Boolean);
      if (slugs.length === 0) {
        throw new Error("Opcja --feeds wymaga listy slugow rozdzielonych przecinkami.");
      }
      options.selectedSlugs = slugs;
      continue;
    }

    if (arg === "--separate") {
      options.separate = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Nieznana opcja: ${arg}`);
    }

    options.sourceUrl = arg;
  }

  return options;
}

function selectFeeds(config: FeedConfig, selectedSlugs?: string[]): FeedConfig {
  if (!selectedSlugs) {
    return config;
  }

  const feedBySlug = new Map(config.feeds.map((feed) => [feed.slug, feed]));
  const missing = selectedSlugs.filter((slug) => !feedBySlug.has(slug));
  if (missing.length > 0) {
    throw new Error(`Nie znaleziono feedow w configu: ${missing.join(", ")}.`);
  }

  const selected = selectedSlugs.map((slug) => feedBySlug.get(slug) as FeedDefinition);
  return { ...config, feeds: selected };
}

function getRequiredArgValue(args: string[], index: number, optionName: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Opcja ${optionName} wymaga wartosci.`);
  }

  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function loadDotEnvLocal(): Promise<void> {
  const envPath = path.resolve(".env.local");

  try {
    const contents = await readFile(envPath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      process.env[key] ??= rawValue.replace(/^["']|["']$/g, "");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function loadFeedConfig(configPath: string): Promise<FeedConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const rawConfig = await readFile(absoluteConfigPath, "utf8");
  const parsed = JSON.parse(rawConfig) as JsonValue;

  if (!isJsonObject(parsed)) {
    throw new Error(`Config ${configPath} musi byc obiektem JSON.`);
  }

  const outputDir = getString(parsed.outputDir) ?? "feeds";
  const requestQueryParams = parseOptionalStringRecord(parsed.requestQueryParams, "requestQueryParams");
  const feeds = getJsonArray(parsed.feeds).map((feed, index) => parseFeedDefinition(feed, index));

  if (feeds.length === 0) {
    throw new Error(`Config ${configPath} nie zawiera zadnych feedow.`);
  }

  return { outputDir, requestQueryParams, feeds };
}

function parseOptionalStringRecord(value: JsonValue | undefined, fieldName: string): QueryParams | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isJsonObject(value)) {
    throw new Error(`Pole ${fieldName} musi byc obiektem.`);
  }

  const result: QueryParams = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const stringValue = getString(rawValue);
    if (!stringValue) {
      throw new Error(`Pole ${fieldName}.${key} musi byc niepustym stringiem.`);
    }

    result[key] = stringValue;
  }

  return result;
}

function parseFeedDefinition(value: JsonValue, index: number): FeedDefinition {
  if (!isJsonObject(value)) {
    throw new Error(`Feed pod indeksem ${index} musi byc obiektem.`);
  }

  const slug = getString(value.slug);
  const title = getString(value.title);
  const url = getString(value.url);

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`Feed pod indeksem ${index} ma niepoprawny slug.`);
  }

  if (!title) {
    throw new Error(`Feed "${slug}" nie ma tytulu.`);
  }

  if (!url) {
    throw new Error(`Feed "${slug}" nie ma URL-a.`);
  }

  try {
    new URL(url);
  } catch {
    throw new Error(`Feed "${slug}" ma niepoprawny URL: ${url}`);
  }

  return {
    slug,
    title,
    url,
    description: getString(value.description)
  };
}

function getBrowserHeaders(): RequestHeaders {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "pl-PL,pl;q=0.9,en;q=0.8",
    dnt: "1",
    referer: "https://www.pap.pl/",
    "upgrade-insecure-requests": "1",
    "user-agent": USER_AGENT
  };
}

async function fetchBrowserlessHtml(url: string): Promise<string> {
  const token = process.env.BROWSERLESS_API_KEY;
  if (!token) {
    throw new Error("Brakuje BROWSERLESS_API_KEY w srodowisku albo .env.local.");
  }

  const endpoint = new URL(process.env.BROWSERLESS_CONTENT_ENDPOINT ?? DEFAULT_BROWSERLESS_CONTENT_ENDPOINT);
  endpoint.searchParams.set("token", token);

  while (true) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cache-control": "no-cache"
      },
      body: JSON.stringify({
        url,
        bestAttempt: true,
        gotoOptions: {
          referer: "https://www.pap.pl/",
          timeout: 45_000,
          waitUntil: ["domcontentloaded", "networkidle2"]
        },
        setExtraHTTPHeaders: getBrowserHeaders(),
        userAgent: {
          userAgent: USER_AGENT,
          platform: "macOS"
        },
        viewport: {
          width: 1365,
          height: 900,
          deviceScaleFactor: 1,
          isMobile: false
        },
        waitForTimeout: 2_000
      })
    });

    const html = await response.text();
    if (response.status === 429) {
      process.stderr.write(`Browserless zwrocil 429 dla ${url}. Ponowna proba za 1 minute.\n`);
      await sleep(BROWSERLESS_RATE_LIMIT_RETRY_MS);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Browserless zwrocil blad ${response.status}: ${html.slice(0, 500)}`);
    }

    return html;
  }
}

function normalizeWhitespace(value: string): string {
  return decodeHtml(value).replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function absoluteUrl(href: string, sourceUrl: string): string | undefined {
  try {
    return new URL(decodeHtml(href), sourceUrl).toString();
  } catch {
    return undefined;
  }
}

function withQueryParams(url: string, queryParams?: QueryParams): string {
  if (!queryParams || Object.keys(queryParams).length === 0) {
    return url;
  }

  const parsedUrl = new URL(url);
  for (const [key, value] of Object.entries(queryParams)) {
    parsedUrl.searchParams.set(key, value);
  }

  return parsedUrl.toString();
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getJsonArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function extractJsonLdArticles(html: string, sourceUrl: string): Article[] {
  const articles: Article[] = [];
  const scriptPattern =
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(scriptPattern)) {
    const jsonText = decodeHtml(match[1].trim());
    if (!jsonText) {
      continue;
    }

    try {
      collectJsonLdArticles(JSON.parse(jsonText) as JsonValue, sourceUrl, articles);
    } catch {
      // Ignore malformed structured data and continue with link extraction.
    }
  }

  return articles;
}

function collectJsonLdArticles(value: JsonValue, sourceUrl: string, articles: Article[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonLdArticles(item, sourceUrl, articles);
    }
    return;
  }

  if (!isJsonObject(value)) {
    return;
  }

  const graph = getJsonArray(value["@graph"]);
  for (const item of graph) {
    collectJsonLdArticles(item, sourceUrl, articles);
  }

  const items = getJsonArray(value.itemListElement);
  for (const item of items) {
    collectJsonLdArticles(isJsonObject(item) ? item.item ?? item : item, sourceUrl, articles);
  }

  const rawType = value["@type"];
  const types = Array.isArray(rawType) ? rawType : [rawType];
  const isArticle = types.some((type) => {
    const typeName = getString(type);
    return typeName === "Article" || typeName === "NewsArticle" || typeName === "ReportageNewsArticle";
  });

  if (!isArticle) {
    return;
  }

  const title = getString(value.headline) ?? getString(value.name);
  const link = getString(value.url) ?? getString(value.mainEntityOfPage);
  const absoluteLink = link ? absoluteUrl(link, sourceUrl) : undefined;

  if (!title || !absoluteLink) {
    return;
  }

  articles.push({
    title: normalizeWhitespace(title),
    link: absoluteLink,
    description: getString(value.description),
    pubDate: getString(value.datePublished) ?? getString(value.dateModified)
  });
}

function extractLinkedArticles(html: string, sourceUrl: string): Article[] {
  const articles: Article[] = [];
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorPattern)) {
    const attrs = match[1];
    const href = attrs.match(/\bhref=(["'])(.*?)\1/i)?.[2];
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      continue;
    }

    const link = absoluteUrl(href, sourceUrl);
    if (!link || !isLikelyArticleUrl(link, sourceUrl)) {
      continue;
    }

    const rawTitle =
      attrs.match(/\btitle=(["'])(.*?)\1/i)?.[2] ??
      attrs.match(/\baria-label=(["'])(.*?)\1/i)?.[2] ??
      stripTags(match[2]);
    const title = normalizeWhitespace(rawTitle);

    if (!isLikelyArticleTitle(title)) {
      continue;
    }

    articles.push({ title, link, description: extractNearbyDescription(html, match.index + match[0].length) });
  }

  return articles;
}

function extractNewsListArticles(html: string, sourceUrl: string): Article[] {
  const articles: Article[] = [];
  const newsItemPattern = /<li\b[^>]*class=(["'])[^"']*\bnews\b[^"']*\1[^>]*>([\s\S]*?)<\/li>/gi;

  for (const match of html.matchAll(newsItemPattern)) {
    const itemHtml = match[2];
    const href = itemHtml.match(/<a\b[^>]*class=(["'])[^"']*\bnewsLink\b[^"']*\1[^>]*href=(["'])(.*?)\2/i)?.[3];
    const titleHtml = itemHtml.match(/<h[1-6]\b[^>]*class=(["'])[^"']*\btitle\b[^"']*\1[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[2];

    if (!href || !titleHtml) {
      continue;
    }

    const link = absoluteUrl(href, sourceUrl);
    const title = normalizeWhitespace(stripTags(titleHtml));

    if (!link || !isLikelyArticleUrl(link, sourceUrl) || !isLikelyArticleTitle(title)) {
      continue;
    }

    const descriptionHtml = itemHtml.match(/<p\b[^>]*class=(["'])[^"']*\bfield--name-field-lead\b[^"']*\1[^>]*>([\s\S]*?)<\/p>/i)?.[2];
    const pubDate = itemHtml.match(/<time\b[^>]*datetime=(["'])(.*?)\1/i)?.[2];

    articles.push({
      title,
      link,
      description: descriptionHtml ? normalizeWhitespace(stripTags(descriptionHtml)) : undefined,
      pubDate
    });
  }

  return articles;
}

function isLikelyArticleUrl(link: string, sourceUrl: string): boolean {
  const url = new URL(link);
  const source = new URL(sourceUrl);

  if (url.origin !== source.origin) {
    return false;
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === source.pathname.replace(/\/+$/, "")) {
    return false;
  }

  if (!path.startsWith("/aktualnosci/")) {
    return false;
  }

  const rejectedPaths = [
    "/",
    "/gospodarka",
    "/kraj",
    "/swiat",
    "/polityka",
    "/sport",
    "/kultura",
    "/zdrowie",
    "/kontakt",
    "/newsletter"
  ];

  return !rejectedPaths.includes(path) && !/\.(?:jpg|jpeg|png|gif|svg|webp|pdf)$/i.test(path);
}

function isLikelyArticleTitle(title: string): boolean {
  if (title.length < 12) {
    return false;
  }

  const rejectedTitles = [
    "newsletter",
    "serwisy pap",
    "kategorie",
    "strona glowna",
    "strona główna",
    "o pap.pl"
  ];

  return !rejectedTitles.includes(title.toLowerCase());
}

function extractNearbyDescription(html: string, startIndex: number): string | undefined {
  const nearbyHtml = html.slice(startIndex, startIndex + 1200);
  const paragraph = nearbyHtml.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  const description = paragraph ? normalizeWhitespace(stripTags(paragraph)) : undefined;
  return description && description.length > 20 ? description : undefined;
}

function dedupeArticles(articles: Article[]): Article[] {
  const seen = new Set<string>();
  const unique: Article[] = [];

  for (const article of articles) {
    const key = article.link;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(article);
  }

  return unique;
}

function buildRss(feed: FeedDefinition, articles: Article[]): string {
  const now = new Date().toUTCString();
  const items = articles
    .map((article) => {
      const pubDate = article.pubDate ? new Date(article.pubDate).toUTCString() : undefined;

      return [
        "    <item>",
        `      <title>${escapeXml(article.title)}</title>`,
        `      <link>${escapeXml(article.link)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(article.link)}</guid>`,
        article.description ? `      <description>${escapeXml(article.description)}</description>` : undefined,
        article.source
          ? `      <source url="${escapeXml(article.source.url)}">${escapeXml(article.source.title)}</source>`
          : undefined,
        pubDate && pubDate !== "Invalid Date" ? `      <pubDate>${pubDate}</pubDate>` : undefined,
        "    </item>"
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(feed.title)}</title>
    <link>${escapeXml(feed.url)}</link>
    <description>${escapeXml(feed.description ?? feed.title)}</description>
    <language>pl</language>
    <lastBuildDate>${now}</lastBuildDate>
${items}
  </channel>
</rss>`;
}

async function extractArticlesFromFeed(
  feed: FeedDefinition,
  requestQueryParams?: QueryParams
): Promise<Article[]> {
  const html = await fetchBrowserlessHtml(withQueryParams(feed.url, requestQueryParams));
  const articles = dedupeArticles([
    ...extractJsonLdArticles(html, feed.url),
    ...extractNewsListArticles(html, feed.url),
    ...extractLinkedArticles(html, feed.url)
  ]).map((article) => ({
    ...article,
    source: {
      title: feed.title,
      url: feed.url
    }
  }));

  if (articles.length === 0) {
    if (html.includes("_Incapsula_Resource") || html.includes("Incapsula incident")) {
      throw new Error(`PAP zwrocil strone ochrony Incapsula dla ${feed.url}.`);
    }

    throw new Error(`Nie znaleziono artykulow na stronie ${feed.url}.`);
  }

  return articles;
}

async function extractArticlesFromFeedWithRetry(
  feed: FeedDefinition,
  requestQueryParams?: QueryParams
): Promise<Article[]> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_FEED_ATTEMPTS; attempt += 1) {
    try {
      return await extractArticlesFromFeed(feed, requestQueryParams);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < MAX_FEED_ATTEMPTS) {
        process.stderr.write(`Proba ${attempt}/${MAX_FEED_ATTEMPTS} dla ${feed.slug} nieudana: ${message}\n`);
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError;
}

async function extractFeed(feed: FeedDefinition, requestQueryParams?: QueryParams): Promise<string> {
  const articles = await extractArticlesFromFeedWithRetry(feed, requestQueryParams);
  return buildRss(feed, articles);
}

function resolveStorageRoot(config: FeedConfig): string {
  const configuredRoot = process.env.MERGED_RSS_DIR ?? process.env.MERGED_RSS_PATH;
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  return path.resolve(config.outputDir);
}

export function resolveBatchesRoot(config: FeedConfig): string {
  return path.join(resolveStorageRoot(config), BATCHES_DIRNAME);
}

export function createBatchDirectory(batchesRoot: string, generatedAt = new Date()): string {
  return path.join(batchesRoot, formatTimestampForFilename(generatedAt));
}

export function getBatchMergedPath(batchDirectory: string): string {
  return path.join(batchDirectory, FINISHED_MERGED_FILENAME);
}

export function formatTimestampForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function findLatestFinishedBatchMergedPath(batchesRoot: string): Promise<string> {
  const entries = await readdir(batchesRoot, { withFileTypes: true });
  const finishedBatchNames: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const mergedPath = getBatchMergedPath(path.join(batchesRoot, entry.name));
    try {
      await access(mergedPath);
      finishedBatchNames.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  const latestBatchName = finishedBatchNames.sort((left, right) => right.localeCompare(left))[0];
  if (!latestBatchName) {
    const missingError = new Error(`Brak gotowych paczek feedow w ${batchesRoot}.`) as NodeJS.ErrnoException;
    missingError.code = "ENOENT";
    throw missingError;
  }

  return getBatchMergedPath(path.join(batchesRoot, latestBatchName));
}

export async function readMergedFeed(outputPath: string): Promise<string> {
  return (await readFile(outputPath, "utf8")).trimEnd();
}

export async function readLatestMergedFeed(config: FeedConfig): Promise<string> {
  const latestPath = await findLatestFinishedBatchMergedPath(resolveBatchesRoot(config));
  return readMergedFeed(latestPath);
}

async function fetchFeedResults(config: FeedConfig): Promise<FeedResult[]> {
  const results: FeedResult[] = [];

  for (const [index, feed] of config.feeds.entries()) {
    try {
      results.push({
        feed,
        articles: await extractArticlesFromFeedWithRetry(feed, config.requestQueryParams)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ feed, error: message });
    }

    if (index < config.feeds.length - 1) {
      await sleep(FEED_REQUEST_DELAY_MS);
    }
  }

  return results;
}

function buildMergedRssFromResults(results: FeedResult[]): string {
  const articles = results.flatMap((result) => ("articles" in result ? result.articles : []));
  const failures = results
    .filter((result): result is { feed: FeedDefinition; error: string } => "error" in result)
    .map((result) => `${result.feed.slug}: ${result.error}`);

  for (const failure of failures) {
    process.stderr.write(`Blad dla ${failure}\n`);
  }

  const mergedArticles = dedupeArticles(articles);
  if (mergedArticles.length === 0) {
    throw new Error(`Nie udalo sie pobrac zadnych artykulow (${failures.length} bledow).`);
  }

  if (failures.length > 0) {
    process.stderr.write(`Pominieto ${failures.length} feedow z bledami.\n`);
  }

  return buildRss(
    {
      slug: "merged",
      title: "PAP.pl - Wszystkie skonfigurowane dzialy",
      url: "https://www.pap.pl/",
      description: "Polaczony feed RSS ze wszystkich skonfigurowanych dzialow PAP.pl"
    },
    mergedArticles
  );
}

async function writeSeparateFeeds(results: FeedResult[], directory: string): Promise<void> {
  for (const result of results) {
    if (!("articles" in result)) {
      continue;
    }

    const separatePath = path.join(directory, `${result.feed.slug}.xml`);
    const rss = buildRss(result.feed, result.articles);
    await writeFile(separatePath, `${rss}\n`, "utf8");
    process.stderr.write(`Zapisano ${separatePath}\n`);
  }
}

export async function publishPublicMergedFeed(mergedPath: string): Promise<string> {
  const publicPath = path.resolve(PUBLIC_MERGED_FEED_PATH);
  await copyFile(mergedPath, publicPath);
  process.stderr.write(`Opublikowano ${publicPath}\n`);
  return publicPath;
}

export async function writeMergedFeed(config: FeedConfig): Promise<string> {
  const generatedAt = new Date();
  const batchDirectory = createBatchDirectory(resolveBatchesRoot(config), generatedAt);
  const separateDirectory = path.join(batchDirectory, SEPARATE_FEED_DIRNAME);
  const results = await fetchFeedResults(config);

  await mkdir(separateDirectory, { recursive: true });
  await writeSeparateFeeds(results, separateDirectory);

  const rss = buildMergedRssFromResults(results);
  const targetPath = getBatchMergedPath(batchDirectory);
  await writeFile(targetPath, `${rss}\n`, "utf8");
  process.stderr.write(`Zapisano ${targetPath}\n`);
  await publishPublicMergedFeed(targetPath);
  return targetPath;
}

export async function extractMergedFeed(config: FeedConfig): Promise<string> {
  const results = await fetchFeedResults(config);
  return buildMergedRssFromResults(results);
}

async function writeAllFeeds(
  config: FeedConfig,
  outputDirOverride?: string
): Promise<void> {
  const outputDir = path.resolve(outputDirOverride ?? config.outputDir);
  await mkdir(outputDir, { recursive: true });

  const results: Array<{ feed: FeedDefinition; error?: string }> = [];
  for (const [index, feed] of config.feeds.entries()) {
    try {
      const rss = await extractFeed(feed, config.requestQueryParams);
      const outputPath = path.join(outputDir, `${feed.slug}.xml`);
      await writeFile(outputPath, `${rss}\n`, "utf8");
      process.stderr.write(`Zapisano ${outputPath}\n`);
      results.push({ feed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ feed, error: message });
    }

    if (index < config.feeds.length - 1) {
      await sleep(FEED_REQUEST_DELAY_MS);
    }
  }

  const failures = results
    .filter((result): result is { feed: FeedDefinition; error: string } => "error" in result)
    .map((result) => `${result.feed.slug}: ${result.error}`);

  for (const failure of failures) {
    process.stderr.write(`Blad dla ${failure}\n`);
  }

  if (failures.length > 0) {
    throw new Error(`Nie udalo sie wygenerowac ${failures.length} feedow.`);
  }
}

async function main(): Promise<void> {
  await loadDotEnvLocal();
  const options = parseArgs(process.argv.slice(2));
  const loadedConfig = await loadFeedConfig(options.configPath);
  const config = selectFeeds(loadedConfig, options.selectedSlugs);

  if (config.feeds.length === 0) {
    throw new Error("Config nie zawiera zadnych feedow.");
  }

  if (options.sourceUrl && config.feeds.length !== 1) {
    throw new Error("Podaj dokladnie jeden feed (--feeds slug) przy jednoczesnym uzyciu sourceUrl.");
  }

  if (options.separate) {
    await writeAllFeeds(config, options.outputDir);
    return;
  }

  const mergeConfig =
    options.sourceUrl && config.feeds.length === 1
      ? {
          ...config,
          feeds: [
            {
              ...config.feeds[0],
              url: options.sourceUrl
            }
          ]
        }
      : config;

  process.stdout.write(`${await extractMergedFeed(mergeConfig)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Blad: ${message}\n`);
    process.exitCode = 1;
  });
}
