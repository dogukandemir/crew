/** Tiny className joiner, the only "UI kit" this project needs. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
