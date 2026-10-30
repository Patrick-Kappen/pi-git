/** Greet someone; replace this with the real code. */
export function greet(name: string): string {
  const trimmed = name.trim();
  return `Hello, ${trimmed === "" ? "world" : trimmed}!`;
}
