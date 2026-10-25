/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * An in-memory stand-in for the Prisma delegates the connector's OAuth store
 * uses (tests only): create, findUnique, findMany, updateMany, deleteMany and
 * upsert over equality, null, lt/gt, in and OR filters, with `include` over a
 * few relations. Enough to run the store's real code, including its atomic
 * claims, without a database.
 */
type Row = Record<string, any>;

const KEYS: Record<string, string> = { oAuthClient: "id", oAuthGrant: "id", oAuthCode: "codeHash", oAuthToken: "hash", user: "id", workspace: "id" };
const RELATIONS: Record<string, Record<string, [table: string, fk: string]>> = {
  oAuthCode: { grant: ["oAuthGrant", "grantId"] },
  oAuthToken: { grant: ["oAuthGrant", "grantId"] },
  oAuthGrant: { client: ["oAuthClient", "clientId"], user: ["user", "userId"] },
  user: { workspace: ["workspace", "workspaceId"] },
};

const time = (value: unknown) => (value instanceof Date ? value.getTime() : value);

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Row[]).some((branch) => matches(row, branch));
    if (key === "grants") return true; // relation filter used by the sweep; not modelled
    const value = row[key] ?? null;
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as Row;
      if ("lt" in c) return value !== null && time(value)! < time(c.lt)!;
      if ("gt" in c) return value !== null && time(value)! > time(c.gt)!;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      return false;
    }
    return time(value) === time(condition ?? null);
  });
}

export function createFakeDb() {
  const tables: Record<string, Row[]> = { oAuthClient: [], oAuthGrant: [], oAuthCode: [], oAuthToken: [], user: [], workspace: [] };
  let counter = 0;

  const withIncludes = (table: string, row: Row | undefined, include?: Row): Row | null => {
    if (!row) return null;
    const out: Row = { ...row };
    for (const [name, spec] of Object.entries(include ?? {})) {
      const relation = RELATIONS[table]?.[name];
      if (!relation || !spec) continue;
      const [target, fk] = relation;
      const found = tables[target].find((candidate) => candidate[KEYS[target]] === row[fk]);
      out[name] = withIncludes(target, found, typeof spec === "object" ? (spec as Row).include : undefined);
    }
    return out;
  };

  const flattenUnique = (where: Row): Row => {
    const [first] = Object.entries(where);
    return first && first[0].includes("_") && typeof first[1] === "object" ? (first[1] as Row) : where;
  };

  const delegate = (table: string) => ({
    async create({ data }: { data: Row }) {
      const key = KEYS[table];
      if (data[key] !== undefined && tables[table].some((row) => row[key] === data[key])) throw new Error(`Unique constraint failed on ${table}.${key}`);
      const row: Row = { ...data };
      if (table === "oAuthGrant") Object.assign(row, { id: `grant_${++counter}`, createdAt: new Date(), lastUsedAt: null, revokedAt: null });
      if (table === "oAuthClient") Object.assign(row, { createdAt: new Date(), clientUri: data.clientUri ?? null });
      if (table === "oAuthCode") Object.assign(row, { usedAt: null });
      if (table === "oAuthToken") Object.assign(row, { usedAt: null, createdAt: new Date() });
      tables[table].push(row);
      return { ...row };
    },
    async findUnique({ where, include }: { where: Row; include?: Row }) {
      const flat = flattenUnique(where);
      return withIncludes(table, tables[table].find((row) => matches(row, flat)), include);
    },
    async findMany({ where, include }: { where?: Row; include?: Row; orderBy?: unknown }) {
      return tables[table].filter((row) => matches(row, where)).map((row) => withIncludes(table, row, include)!);
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      const hit = tables[table].filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    },
    async deleteMany({ where }: { where: Row }) {
      const before = tables[table].length;
      tables[table] = tables[table].filter((row) => !matches(row, where));
      return { count: before - tables[table].length };
    },
    async upsert({ where, create, update }: { where: Row; create: Row; update: Row }) {
      const existing = tables[table].find((row) => matches(row, flattenUnique(where)));
      if (existing) return { ...Object.assign(existing, update) };
      return this.create({ data: create });
    },
  });

  const db = {
    tables,
    oAuthClient: delegate("oAuthClient"),
    oAuthGrant: delegate("oAuthGrant"),
    oAuthCode: delegate("oAuthCode"),
    oAuthToken: delegate("oAuthToken"),
    user: delegate("user"),
    workspace: delegate("workspace"),
    reset() {
      for (const name of Object.keys(tables)) tables[name] = [];
      counter = 0;
    },
    /** A person with a workspace, as the token check loads them. */
    seedUser(id = "user_1") {
      tables.workspace.push({ id: `ws_${id}`, name: "Studio" });
      tables.user.push({ id, email: `${id}@example.com`, name: "Test", workspaceId: `ws_${id}`, isAdmin: false });
      return id;
    },
  };
  return db;
}

export type FakeDb = ReturnType<typeof createFakeDb>;
