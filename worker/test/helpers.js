import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function createDb() {
  const db = new DatabaseSync(":memory:");
  for (const file of ["0001_init.sql", "0002_approval_email.sql", "0003_video_link.sql", "0004_consent_nullable.sql"]) {
    db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  return db;
}

export function d1(db) {
  return {
    prepare(sql) {
      const run = (params) => {
        const info = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(info.changes || 0) } };
      };
      const first = (params) => db.prepare(sql).get(...params) ?? null;
      const all = (params) => ({ results: db.prepare(sql).all(...params) });
      return {
        bind(...params) {
          return {
            run: async () => run(params),
            first: async () => first(params),
            all: async () => all(params),
          };
        },
        run: async () => run([]),
        first: async () => first([]),
        all: async () => all([]),
      };
    },
  };
}

export function makeEnv(db, overrides = {}) {
  return {
    DB: d1(db),
    ALLOWED_ORIGINS: "https://www.spheresce.com,https://pages.example",
    ALLOW_LOCALHOST: "false",
    NOTIFY_EMAIL_ENABLED: "false",
    EMAIL_PROVIDER: "off",
    ADMIN_PASSWORD: "correct-horse-battery",
    COOKIE_SECURE: "false",
    RATE_LIMIT_SALT: "test-salt",
    ...overrides,
  };
}

export function payload(overrides = {}) {
  return {
    requestType: "Demo request",
    fullName: "Jordan Lee",
    jobTitle: "Lead Statistical Programmer",
    organization: "Northwind Biometrics",
    workEmail: "jordan.lee@northwindbio.example",
    phone: "+1 202 555 0143",
    faxNumber: "",
    formLoadedAt: Date.now() - 10_000,
    ...overrides,
  };
}

export function countRequests(db) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM demo_requests").get().n);
}
