// Export the full reachable NAT history (進+銷, queryInvType=0) as the government's
// native CSV, one file per month, resumable. Range defaults to 2020-02 → current month.
//   NAT_OP_ITEM='<your 1Password item>' bun run nat-export-history.ts [fromYm] [toYm]
//   OUTDIR=/path/to/dir  overrides the output directory (default ./out/nat-history).
import { mkdirSync, writeFileSync, existsSync, statSync, renameSync, rmSync } from "node:fs";
import { NatClient, isMonthArchived } from "./nat-client.ts";

const fromYm = process.argv[2] ?? "2020-02";
// Resolve "current month" in Asia/Taipei (the portal's zone), not the host's, so a
// non-Taipei runner near a month boundary doesn't target the wrong month.
const currentYm = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" }).slice(0, 7);
const toYm = process.argv[3] ?? currentYm;
const OUTDIR = process.env.OUTDIR ?? "./out/nat-history";
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
  console.log(`logged in ${ban}; exporting native CSV ${fromYm}..${toYm} → ${OUTDIR}\n`);
  let done = 0, skipped = 0, failed = 0;
  for (const ym of months(fromYm, toYm)) {
    const out = `${OUTDIR}/nat_${ban}_${ym}.csv`;
    const empty = `${out}.empty`;
    // Only closed months are final; the current (still-open) month is always re-fetched
    // so invoices added later in the month aren't missed on a resumed/scheduled run.
    const hasData = existsSync(out) && statSync(out).size > 0;
    if (isMonthArchived(hasData, existsSync(empty)) && ym !== currentYm) { console.log(`${ym}  (skip, archived)`); skipped++; continue; }
    const [y, m] = ym.split("-").map(Number);
    const to = `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
    const stamp = Date.now();
    try {
      await client.createReportJob({ ban, from: `${ym}-01`, to, invType: "0", fileType: "CSV" });
      let job;
      for (let i = 0; i < 60 && !job; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        job = (await client.listJobs())
          .filter((j) => j.ban === ban && j.fileType === "CSV" && j.status === "2" && j.sellbuyType === "0" && j.queryStartDate?.startsWith(ym) && Date.parse(j.applyDate) >= stamp - 120_000)
          .sort((a, b) => b.seqNo - a.seqNo)[0];
      }
      if (!job) { console.log(`${ym}  ⚠️ job not ready (timeout)`); failed++; continue; }
      if (Number(job.dataCount) === 0) {
        writePrivateAtomic(empty, `no invoices for ${ym}\n`);
        if (existsSync(out)) rmSync(out); // drop a stale data file if this month is now empty
        console.log(`${ym}  (empty)`);
        done++;
        continue;
      }
      const bytes = await client.downloadJob(job);
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
