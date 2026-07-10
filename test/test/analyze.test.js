import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  SERVERS,
  buildResultsTable,
  extractMetric,
  summarizeBenchmark,
} from "../analyze.js"

test("extracts wrk request and latency metrics", () => {
  const wrkOutput = `
Running 10s test @ http://localhost:8000/graphql
  Latency   872.50us  123.45us   1.02ms   90.00%
Requests/sec: 12345.67
`

  assert.equal(extractMetric(wrkOutput, "Requests/sec"), 12345.67)
  assert.equal(extractMetric(wrkOutput, "Latency"), 0.8725)
})

test("summarizes three runs for each server", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graphql-benchmarks-"))
  const resultFiles = []

  SERVERS.forEach((server, serverIndex) => {
    for (let run = 1; run <= 3; run += 1) {
      const fileName = `bench2-${server}-${run}.txt`
      resultFiles.push(fileName)
      fs.writeFileSync(
        path.join(tmpDir, fileName),
        `Latency   ${serverIndex + run}.00ms\nRequests/sec: ${
          100 * (serverIndex + 1) + run
        }\n`,
      )
    }
  })

  const summary = summarizeBenchmark(resultFiles, { cwd: tmpDir })

  assert.equal(summary.whichBench, 2)
  assert.equal(summary.avgReqSecs.apollo, 102)
  assert.equal(summary.avgLatencies.apollo, 2)
  fs.rmSync(tmpDir, { force: true, recursive: true })
})

test("builds a sorted markdown results table", () => {
  const avgReqSecs = Object.fromEntries(
    SERVERS.map((server, index) => [server, index + 1]),
  )
  const avgLatencies = Object.fromEntries(SERVERS.map((server) => [server, 10]))
  const table = buildResultsTable(1, avgReqSecs, avgLatencies)

  assert.match(table, /PERFORMANCE_RESULTS_START/)
  assert.match(table, /\[GraphQL JIT\].*\[Hasura\]/s)
  assert.match(table, /`8\.00x`/)
})
