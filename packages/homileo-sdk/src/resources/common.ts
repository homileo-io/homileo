import { z } from "zod";

export const Id = z.guid();
export const Timestamp = z.iso.datetime();
export const Metadata = z.record(z.string(), z.unknown());
