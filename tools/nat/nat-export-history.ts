// Export the full reachable NAT history (進+銷, queryInvType=0) as the government's
// native CSV, one file per month, resumable. Range defaults to 2020-02 → 2026-08.
//   NAT_OP_ITEM='<your 1Password item>' bun run nat-export-history.ts [fromYm] [toYm]
//   OUTDIR=/path/to/dir  overrides the output directory (default ./out/nat-history).
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { NatClient } from "./nat-client.ts";

const fromYm = process.argv[2] ?? "2020-02";
const toYm = process.argv[3] ?? "2026-08";
const OUTDIR = process.env.OUTDIR ?? "./out/nat-history";
mkdirSync(OUTDIR, { recursive: true });

function months(a: string, b: string): string[] {
  const [fy, fm] = a.split("-").map(Number); const [ty, tm] = b.split("-").map(Number);
  const r: string[] = []; let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) { r.push(`${y}-${String(m).padStart(2, "0")}`); if (++m > 12) { m = 1; y++; } }
  return r;
}

const client = await NatClient.login();
try {
  const ban = (await client.authorizedCompanies())[0].ban;
  console.log(`logged in ${ban}; exporting native CSV ${fromYm}..${toYm} → ${OUTDIR}\n`);
  let done = 0, skipped = 0, failed = 0;
  for (const ym of months(fromYm, toYm)) {
    const out = `${OUTDIR}/nat_${ban}_${ym}.csv`;
    if (existsSync(out) && statSync(out).size > 0) { console.log(`${ym}  (skip, exists)`); skipped++; continue; }
    const [y, m] = ym.split("-").map(Number);
    const to = `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
    const stamp = Date.now();
    try {
      await client.createReportJob({ ban, from: `${ym}-01`, to, invType: "0", fileType: "CSV" });
      let job;
      for (let i = 0; i < 60 && !job; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        job = (await client.listJobs())
          .filter((j) => j.fileType === "CSV" && j.status === "2" && j.sellbuyType === "0" && j.queryStartDate?.startsWith(ym) && Date.parse(j.applyDate) >= stamp - 120_000)
          .sort((a, b) => b.seqNo - a.seqNo)[0];
      }
      if (!job) { console.log(`${ym}  ⚠️ job not ready (timeout)`); failed++; continue; }
      const bytes = await client.downloadJob(job);
      writeFileSync(out, bytes);
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
