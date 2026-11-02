import { isDatabaseBusy } from "../utils/errors.js";
import type { AckError } from "./types.js";

/** A refusal or ack code for an unexpected failure: retryable when the database was busy. */
export const failureCode = (
  err: unknown
): "temporarily_unavailable" | "server_error" =>
  isDatabaseBusy(err) ? "temporarily_unavailable" : "server_error";

export const failureAck = (err: unknown): AckError =>
  failureCode(err) === "temporarily_unavailable"
    ? {
        code: "temporarily_unavailable",
        message: "The service is busy; try again",
      }
    : { code: "server_error", message: "Something went wrong" };
