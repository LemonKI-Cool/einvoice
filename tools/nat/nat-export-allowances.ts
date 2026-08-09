// Export 折讓單 (btb412w) history as native CSV, one file per month, resumable.
//   NAT_OP_ITEM='<your 1Password item>' bun run nat-export-allowances.ts [fromYm] [toYm]
//   OUTDIR=/path/to/dir  overrides the output directory (default ./out/nat-allowances).
import { mkdirSync, writeFileSync, existsSync, statSync, renameSync, rmSync } from "node:fs";
import { NatClient, isMonthArchived } from "./nat-client.ts";

const fromYm = process.argv[2] ?? "2020-02";
// Resolve "current month" in Asia/Taipei (the portal's zone), not the host's.
const currentYm = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" }).slice(0, 7);
const toYm = process.argv[3] ?? currentYm;
const OUTDIR = process.env.OUTDIR ?? "./out/nat-allowances";
mkdirSync(OUTDIR, { recursive: true });

if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(fromYm) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(toYm) || fromYm > toYm) {
  throw new Error(`invalid month range: ${fromYm}..${toYm}`);
}

function writePrivateAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

function months(a: string, b: string): string[] {
  const [fy, fm] = a.split("-").map(Number); const [ty, tm] = b.split("-").map(Number);
  const r: string[] = []; let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) { r.push(`${y}-${String(m).padStart(2, "0")}`); if (++m > 12) { m = 1; y++; } }
  return r;
}

const client = await NatClient.login();
try {
  const ban = (await client.authorizedCompany()).ban;
  console.log(`logged in ${ban}; exporting 折讓單 native CSV ${fromYm}..${toYm} → ${OUTDIR}\n`);
  let done = 0, skipped = 0, failed = 0;
  for (const ym of months(fromYm, toYm)) {
    const out = `${OUTDIR}/alw_${ban}_${ym}.csv`;
    const empty = `${out}.empty`;
    // Only closed months are final; the current (still-open) month is always re-fetched.
    const hasData = existsSync(out) && statSync(out).size > 0;
    if (isMonthArchived(hasData, existsSync(empty)) && ym !== currentYm) { console.log(`${ym}  (skip, archived)`); skipped++; continue; }
    const [y, m] = ym.split("-").map(Number);
    const to = `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
    const stamp = Date.now();
    try {
      await client.createAllowanceJob({ ban, from: `${ym}-01`, to, invType: "0", fileType: "CSV" });
      let job;
      for (let i = 0; i < 60 && !job; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        // match THIS month's job for THIS company, applied in this run, newest first
        job = (await client.listAllowanceJobs())
          .filter((j) => j.ban === ban && j.fileType === "CSV" && j.status === "2" && j.queryStartDate?.startsWith(ym) && Date.parse(j.applyDate) >= stamp - 120_000)
          .sort((a, b) => b.seqNo - a.seqNo)[0];
      }
      if (!job) { console.log(`${ym}  ⚠️ job not ready (timeout)`); failed++; continue; }
      if (Number(job.dataCount) === 0) {
        writePrivateAtomic(empty, `no allowances for ${ym}\n`); // empty month (download would 400); marker for resumability
        if (existsSync(out)) rmSync(out); // drop a stale data file if this month is now empty
        console.log(`${ym}  (empty, no 折讓)`);
        done++;
        continue;
      }
      const bytes = await client.downloadAllowanceJob(job);
      if (bytes.length === 0) throw new Error("download returned an empty file");
      writePrivateAtomic(out, bytes);
      if (existsSync(empty)) rmSync(empty); // month now has data — drop the stale empty marker
      console.log(`${ym}  M+D=${job.dataCount}  ${(bytes.length / 1024).toFixed(0)}KB  -> ${out.split("/").pop()}`);
      done++;
    } catch (e) {
      console.log(`${ym}  ERROR ${(e as Error).message?.slice(0, 90)}`);
      failed++;
    }
  }
  console.log(`\nDONE: ${done} downloaded, ${skipped} skipped, ${failed} failed. Dir: ${OUTDIR}`);
} finally {
  await client.close();
}
