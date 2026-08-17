import type { ModelListItem } from "@/lib/types";

const MODEL_SEARCH_LIMIT = 50;

type ModelSearchEntry = {
  model: ModelListItem;
  name: string;
  text: string;
};

export function createModelSearchIndex(models: ModelListItem[]): ModelSearchEntry[] {
  return models.map((model) => ({
    model,
    name: normalizeSearchText(model.name ?? model.label),
    text: normalizeSearchText(
      `${model.name ?? ""} ${model.label} ${model.provider} ${model.modelId}`,
    ),
  }));
}

export function searchModelIndex(index: ModelSearchEntry[], search: string): ModelListItem[] {
  const normalizedSearch = normalizeSearchText(search);
  if (normalizedSearch.length < 2) return [];
  const terms = normalizedSearch.split(" ");

  return index
    .filter((entry) => terms.every((term) => entry.text.includes(term)))
    .sort((a, b) => compareSearchEntries(a, b, normalizedSearch))
    .slice(0, MODEL_SEARCH_LIMIT)
    .map((entry) => entry.model);
}

function compareSearchEntries(
  a: ModelSearchEntry,
  b: ModelSearchEntry,
  normalizedSearch: string,
): number {
  const availability = compareModelAvailability(a.model, b.model);
  if (availability !== 0) return availability;
  const prefix =
    Number(b.name.startsWith(normalizedSearch)) - Number(a.name.startsWith(normalizedSearch));
  if (prefix !== 0) return prefix;
  const nameLength = a.name.length - b.name.length;
  if (nameLength !== 0) return nameLength;
  const name = a.name.localeCompare(b.name);
  if (name !== 0) return name;
  const provider = a.model.provider.localeCompare(b.model.provider);
  if (provider !== 0) return provider;
  return a.model.modelId.localeCompare(b.model.modelId);
}

function compareModelAvailability(a: ModelListItem, b: ModelListItem): number {
  return Number(b.authKind !== "none") - Number(a.authKind !== "none");
}

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
