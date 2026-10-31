export const iso = (date: Date): string => date.toISOString();

export const isoOrNull = (date: Date | null): string | null =>
  date ? date.toISOString() : null;

/** Metadata columns hold a flat object by the write routes' validation. */
export const metadataOf = (value: unknown): Record<string, unknown> =>
  value as Record<string, unknown>;
