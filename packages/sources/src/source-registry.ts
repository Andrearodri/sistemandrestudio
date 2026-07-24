import type { SourceDefinition } from "./types.ts";

export const OFFICIAL_SOURCE_CATALOG_VERSION = "official-source-catalog-v1";

export const OFFICIAL_SOURCE_CATALOG: readonly SourceDefinition[] = [
  {
    id: "cloudflare-blog", name: "Cloudflare Blog", organization: "Cloudflare",
    feedUrl: "https://blog.cloudflare.com/rss/", feedFormat: "RSS", authority: "OFFICIAL",
    topics: ["cloudflare", "application_security", "web_development"], enabled: true,
    minimumIntervalMinutes: 60, retentionDays: 90, allowedHosts: ["blog.cloudflare.com"],
    notes: "Blog técnico oficial.",
  },
  {
    id: "github-blog", name: "GitHub Blog", organization: "GitHub",
    feedUrl: "https://github.blog/feed/", feedFormat: "RSS", authority: "OFFICIAL",
    topics: ["github", "apis", "automation"], enabled: true,
    minimumIntervalMinutes: 60, retentionDays: 90, allowedHosts: ["github.blog"],
    notes: "Blog oficial de produto e engenharia.",
  },
  {
    id: "nodejs-blog", name: "Node.js Blog", organization: "Node.js",
    feedUrl: "https://nodejs.org/en/feed/blog.xml", feedFormat: "AUTO", authority: "OFFICIAL",
    topics: ["nodejs", "web_development", "application_security"], enabled: true,
    minimumIntervalMinutes: 60, retentionDays: 90, allowedHosts: ["nodejs.org"],
    notes: "Blog oficial do projeto Node.js.",
  },
  {
    id: "google-developers-blog", name: "Google Developers Blog", organization: "Google",
    feedUrl: "https://developers.googleblog.com/feeds/posts/default?alt=rss", feedFormat: "RSS", authority: "OFFICIAL",
    topics: ["artificial_intelligence", "apis", "web_development"], enabled: true,
    minimumIntervalMinutes: 60, retentionDays: 90, allowedHosts: ["developers.googleblog.com"],
    notes: "Canal oficial para desenvolvedores.",
  },
  {
    id: "react-blog", name: "React Blog", organization: "React",
    feedUrl: "https://react.dev/rss.xml", feedFormat: "RSS", authority: "OFFICIAL",
    topics: ["react", "web_development"], enabled: true,
    minimumIntervalMinutes: 60, retentionDays: 90, allowedHosts: ["react.dev"],
    notes: "Blog oficial do projeto React.",
  },
];

export function getOfficialSource(sourceId: string): SourceDefinition | undefined {
  return OFFICIAL_SOURCE_CATALOG.find((source) => source.id === sourceId);
}

export function listEnabledOfficialSources(): readonly SourceDefinition[] {
  return OFFICIAL_SOURCE_CATALOG.filter((source) => source.enabled);
}
