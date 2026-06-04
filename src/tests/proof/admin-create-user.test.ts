import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("admin create-user: bypasses allowlist, returns temp password, dup 409, unauth 401", async () => {
  process.env.HOME = mkdtempSync(path.join(tmpdir(), "adduser-"));
  process.env.WIKI_OWNER_HOSTS = "localhost";
  const { writeConfig } = await import("../../lib/config.js");
  const { auth, authReady } = await import("../../lib/auth/server.js");
  await authReady();
  const adminRes = await auth.api.signUpEmail({ body: { email: "admin@x.com", password: "test1234!", name: "Admin" }, asResponse: true });
  const cookie = (adminRes.headers.get("set-cookie") ?? "").split(/,(?=[^ ])/).map(c=>c.split(";")[0].trim()).join("; ");
  const adminBody = await adminRes.json() as any;
  const { ensureBootstrapAdmin } = await import("../../lib/auth/admin.js");
  await ensureBootstrapAdmin(adminBody.user.id);
  // lock allowlist; admin create must bypass
  await writeConfig({ allowedEmails: ["onlythis@allowed.com"] });
  const { POST } = await import("../../app/api/system/users/route.js");
  const req = new Request("http://localhost:3000/api/system/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", cookie },
    body: JSON.stringify({ email: "newbie@notallowed.com", name: "New Bie" }),
  });
  const res = await POST(req);
  const out = await res.json() as any;
  assert.equal(res.status, 200);
  assert.ok(out.tempPassword && out.tempPassword.length >= 16, "temp password returned");
  assert.equal(out.email, "newbie@notallowed.com");
  // dup -> 409
  const res2 = await POST(new Request("http://localhost:3000/api/system/users", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", cookie },
    body: JSON.stringify({ email: "newbie@notallowed.com" }),
  }));
  assert.equal(res2.status, 409);
  // non-admin -> 403 (no cookie)
  const res3 = await POST(new Request("http://localhost:3000/api/system/users", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ email: "x@y.com" }),
  }));
  assert.equal(res3.status, 401);
});
