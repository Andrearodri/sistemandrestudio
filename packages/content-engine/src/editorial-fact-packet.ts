import type { EditorialBrief } from "./editorial-drafting.ts";

export const WEBMCP_PROHIBITED_QUALIFIERS = ["preview", "beta", "versão", "version", "disponibilidade", "disponível", "available"] as const;

export interface EditorialFactPacket {
  readonly entity: string;
  readonly announcementType: "OFFICIAL_ANNOUNCEMENT" | "CONFIRMED_FACT";
  readonly supportedFacts: readonly string[];
  readonly officialUrl: string;
  readonly allowedQualifiers: readonly string[];
  readonly prohibitedQualifiers: readonly string[];
}

export function createEditorialFactPacket(brief: EditorialBrief, officialUrl = firstOfficialUrl(brief)): EditorialFactPacket {
  const supportedFacts = brief.allowedFacts.map((fact) => fact.statement).filter(Boolean);
  const sourceText = supportedFacts.join(" ");
  const allowedQualifiers = brief.allowedFacts.flatMap((fact) => fact.restrictions.flatMap((restriction) => {
    const match = restriction.match(/Qualificador comprovado:\s*(preview|beta)/iu);
    return match?.[1] ? [match[1].toLowerCase()] : [];
  }));
  const uniqueAllowed = [...new Set(allowedQualifiers)];
  const prohibited = WEBMCP_PROHIBITED_QUALIFIERS.filter((qualifier) => !uniqueAllowed.includes(qualifier));
  return {
    entity: brief.subject.product ?? brief.subject.organization ?? "entidade não determinada",
    announcementType: /anunci|announc|introduc|lan[cç]/iu.test(sourceText) ? "OFFICIAL_ANNOUNCEMENT" : "CONFIRMED_FACT",
    supportedFacts,
    officialUrl,
    allowedQualifiers: uniqueAllowed,
    prohibitedQualifiers: prohibited,
  };
}

export function findProhibitedEditorialQualifiers(text: string, packet: EditorialFactPacket): readonly string[] {
  const normalized = text.toLocaleLowerCase("pt-BR");
  return packet.prohibitedQualifiers.filter((qualifier) => normalized.includes(qualifier.toLocaleLowerCase("pt-BR")));
}

function firstOfficialUrl(brief: EditorialBrief): string {
  return brief.sourceReferences.find((citation) => citation.canonicalUrl.startsWith("https://"))?.canonicalUrl ?? "";
}
