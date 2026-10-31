import type { ResolvedSpaceKind } from "../definitions/builtins.js";
import { BadRequestError } from "./errors.js";

// A space's field, and the name a kind's `overridable` and `defaults` give it.
const SETTINGS = [
  ["visibility", "visibility"],
  ["joinPolicy", "join"],
  ["postPolicy", "posting"],
] as const;

type Given = {
  visibility?: string;
  joinPolicy?: string;
  postPolicy?: string;
};

/** A setting the kind does not let spaces override is refused, even when it equals the default. */
export const assertOverridable = (
  kind: ResolvedSpaceKind,
  given: Given
): void => {
  for (const [field, setting] of SETTINGS) {
    if (given[field] !== undefined && !kind.overridable.includes(setting)) {
      throw new BadRequestError(
        "setting_not_overridable",
        `The kind "${kind.name}" does not let spaces set ${field}`
      );
    }
  }
};

/** A state must be null or one the kind declares. */
export const assertState = (
  kind: ResolvedSpaceKind,
  state: string | null | undefined
): void => {
  if (state != null && !kind.states.includes(state)) {
    throw new BadRequestError(
      "invalid_state",
      `"${state}" is not a state of the kind "${kind.name}"`
    );
  }
};
