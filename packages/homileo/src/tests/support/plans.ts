import { prisma } from "../../utils/db/prisma.js";
import { vi } from "vitest";
import pg from "pg";

export interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
}

interface SentQuery {
  text: string;
  values: unknown[];
}

/** The queries `run` sends to Postgres whose text matches `pattern`, as Prisma wrote them. */
export const queriesOf = async (
  run: () => Promise<unknown>,
  pattern: RegExp
): Promise<SentQuery[]> => {
  const sent: SentQuery[] = [];
  const query = pg.Client.prototype.query;
  const spy = vi
    .spyOn(pg.Client.prototype, "query")
    .mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const config = args[0] as Partial<SentQuery> | string;
      if (typeof config === "object" && config.text !== undefined) {
        sent.push({ text: config.text, values: config.values ?? [] });
      }
      return (query as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return sent.filter((q) => pattern.test(q.text));
};

/** The planner's plan for `q`, every node flattened, with sequential scans off as the seed is small. */
export const planOf = async (q: SentQuery): Promise<PlanNode[]> => {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
    return tx.$queryRawUnsafe<Array<{ "QUERY PLAN": [{ Plan: PlanNode }] }>>(
      `EXPLAIN (FORMAT JSON) ${q.text}`,
      ...q.values
    );
  });
  const walk = (n: PlanNode): PlanNode[] => [
    n,
    ...(n.Plans ?? []).flatMap(walk),
  ];
  return walk(rows[0]!["QUERY PLAN"][0].Plan);
};

export const SORTS = ["Sort", "Incremental Sort"];
