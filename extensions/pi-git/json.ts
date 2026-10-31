/** The first JSON object in a model answer, also inside a ```json fence or after some text. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const candidate = fenced ? (fenced[1] as string) : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("no JSON object in the answer");
  return JSON.parse(candidate.slice(start, end + 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string field, trimmed. */
export function stringField(value: unknown, key: string, optional = false): string | Error {
  if (!isRecord(value)) return new Error("expected a JSON object");
  const field = value[key];
  if (field === undefined && optional) return "";
  if (typeof field !== "string" || (!optional && field.trim() === ""))
    return new Error(`"${key}" must be a non-empty string`);
  return field.trim();
}
