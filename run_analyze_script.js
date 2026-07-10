#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { SERVERS, fileNameForServer } from "./analyze.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function filesForBench(bench) {
  const resultFiles = []

  SERVERS.forEach((server) => {
    const fileServer = fileNameForServer(server)

    for (let run = 1; run <= 3; run += 1) {
      resultFiles.push(
        `bench${bench}_result${run}_graphql_${fileServer}_run.sh.txt`,
      )
    }
  })

  return resultFiles
}

function runAnalyze(bench) {
  const analyzeScript = path.join(__dirname, "analyze.js")
  const resultFiles = filesForBench(bench)

  console.log(`Processing files for bench${bench}:`)
  console.log(`Executing: node analyze.js ${resultFiles.join(" ")}`)

  const result = spawnSync(process.execPath, [analyzeScript, ...resultFiles], {
    cwd: process.cwd(),
    stdio: "inherit",
  })

  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

function main() {
  fs.rmSync(path.join(process.cwd(), "results.md"), { force: true })

  for (let bench = 1; bench <= 3; bench += 1) {
    runAnalyze(bench)
  }
}

if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
}

export { filesForBench }
