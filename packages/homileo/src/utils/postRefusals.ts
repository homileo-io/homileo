import {
  ArchivedError,
  NotAParticipantError,
  NotFoundError,
  PostingRestrictedError,
} from "./errors.js";

/** The error for each reason `postRefusal` gives. */
export const postRefusalError = {
  not_found: () => new NotFoundError("Session not found"),
  archived: () => new ArchivedError("The session is archived"),
  not_a_participant: () => new NotAParticipantError(),
  posting_restricted: () => new PostingRestrictedError(),
};
