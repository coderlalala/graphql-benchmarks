#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SERVERS = [
  "apollo",
  "caliban",
  "netflixdgs",
  "gqlgen",
  "tailcall",
  "async_graphql",
  "hasura",
  "graphql_jit",
]

const FORMATTED_SERVER_NAMES = {
  tailcall: "Tailcall",
  gqlgen: "Gqlgen",
  apollo: "Apollo GraphQL",
  netflixdgs: "Netflix DGS",
  caliban: "Caliban",
  async_graphql: "async-graphql",
  hasura: "Hasura",
  graphql_jit: "GraphQL JIT",
}

const QUERY_BY_BENCH = {
  1: "{ posts { id userId title user { id name email }}}",
  2: "{ posts { title }}",
  3: "{ greet }",
}

function fileNameForServer(server) {
  if (server === "apollo") return "apollo_server"
  if (server === "netflixdgs") return "netflix_dgs"
  return server
}

function average(values) {
  if (values.length === 0) {
    throw new Error("Cannot average an empty set of values")
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function parseMetricValue(value, metric) {
  const match = String(value).trim().match(/^([0-9]*\.?[0-9]+)([a-z]+)?$/i)
  if (!match) {
    throw new Error(`Could not parse ${metric} value: ${value}`)
  }

  const numericValue = Number(match[1])
  const unit = (match[2] || "").toLowerCase()

  if (metric === "Latency") {
    if (unit === "us") return numericValue / 1000
    if (unit === "s") return numericValue * 1000
  }

  return numericValue
}

function extractMetric(content, metric) {
  const line = content
    .split(/\r?\n/)
    .find((candidate) => candidate.includes(metric))

  if (!line) {
    throw new Error(`Could not find metric "${metric}"`)
  }

  const metricRegex =
    metric === "Requests/sec"
      ? /Requests\/sec:\s*([0-9]*\.?[0-9]+)/
      : /Latency\s+([0-9]*\.?[0-9]+(?:us|ms|s)?)/i
  const match = line.match(metricRegex)

  if (match) {
    return parseMetricValue(match[1], metric)
  }

  const [, value] = line.trim().split(/\s+/)
  return parseMetricValue(value, metric)
}

function detectBench(resultFiles) {
  const firstFile = path.basename(resultFiles[0] || "")

  if (firstFile.startsWith("bench2")) return 2
  if (firstFile.startsWith("bench3")) return 3
  return 1
}

function summarizeBenchmark(resultFiles, options = {}) {
  const cwd = options.cwd || process.cwd()
  const expectedFileCount = SERVERS.length * 3

  if (resultFiles.length !== expectedFileCount) {
    throw new Error(
      `Expected ${expectedFileCount} result files, received ${resultFiles.length}`,
    )
  }

  const avgReqSecs = {}
  const avgLatencies = {}

  SERVERS.forEach((server, serverIndex) => {
    const startIndex = serverIndex * 3
    const reqSecValues = []
    const latencyValues = []

    for (let runIndex = 0; runIndex < 3; runIndex += 1) {
      const resultFile = resultFiles[startIndex + runIndex]
      const resultPath = path.resolve(cwd, resultFile)

      if (!fs.existsSync(resultPath)) {
        throw new Error(`Result file not found: ${resultFile}`)
      }

      const content = fs.readFileSync(resultPath, "utf8")
      reqSecValues.push(extractMetric(content, "Requests/sec"))
      latencyValues.push(extractMetric(content, "Latency"))
    }

    avgReqSecs[server] = average(reqSecValues)
    avgLatencies[server] = average(latencyValues)
  })

  return { avgLatencies, avgReqSecs, whichBench: detectBench(resultFiles) }
}

function formatNumber(value) {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })
}

function getSortedServers(avgReqSecs) {
  return [...SERVERS].sort((left, right) => avgReqSecs[right] - avgReqSecs[left])
}

function buildResultsTable(whichBench, avgReqSecs, avgLatencies) {
  const rows = []
  const sortedServers = getSortedServers(avgReqSecs)
  const slowestServer = sortedServers[sortedServers.length - 1]
  const slowestReqSecs = avgReqSecs[slowestServer]

  if (whichBench === 1) {
    rows.push("<!-- PERFORMANCE_RESULTS_START -->")
    rows.push("")
    rows.push("| Query | Server | Requests/sec | Latency (ms) | Relative |")
    rows.push("|-------:|--------:|--------------:|--------------:|---------:|")
  }

  rows.push(`| ${whichBench} | \`${QUERY_BY_BENCH[whichBench]}\` |`)

  sortedServers.forEach((server) => {
    const relativePerformance = (avgReqSecs[server] / slowestReqSecs).toFixed(2)

    rows.push(
      `|| [${FORMATTED_SERVER_NAMES[server]}] | \`${formatNumber(
        avgReqSecs[server],
      )}\` | \`${formatNumber(avgLatencies[server])}\` | \`${relativePerformance}x\` |`,
    )
  })

  if (whichBench === 3) {
    rows.push("")
    rows.push("<!-- PERFORMANCE_RESULTS_END -->")
  }

  return rows.join("\n")
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" })
  return result.status === 0
}

function ensureGnuplot() {
  if (commandExists("gnuplot")) return

  if (process.platform === "linux" && commandExists("apt-get")) {
    console.log("Installing gnuplot...")
    spawnSync("sudo", ["apt-get", "update"], { stdio: "inherit" })
    spawnSync("sudo", ["apt-get", "install", "-y", "gnuplot"], {
      stdio: "inherit",
    })
  }

  if (!commandExists("gnuplot")) {
    throw new Error("gnuplot is required to generate histogram images")
  }
}

function gnuplotPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/"/g, '\\"')
}

function writeDataFile(filePath, avgValues) {
  const lines = ["Server Value"]

  SERVERS.forEach((server) => {
    lines.push(`${server} ${avgValues[server]}`)
  })

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`)
}

function writeHistogram({
  avgValues,
  dataFile,
  outputFile,
  title,
  seriesTitle,
}) {
  ensureGnuplot()
  writeDataFile(dataFile, avgValues)

  const gnuplotScript = `
set term pngcairo size 1280,720 enhanced font "Courier,12"
set output "${gnuplotPath(outputFile)}"
set style data histograms
set style histogram cluster gap 1
set style fill solid border -1
set xtics rotate by -45
set boxwidth 0.9
set title "${title}"
stats "${gnuplotPath(dataFile)}" using 2 nooutput
set yrange [0:STATS_max*1.2]
set key outside right top
plot "${gnuplotPath(dataFile)}" using 2:xtic(1) title "${seriesTitle}"
`
  const scriptFile = path.join(
    os.tmpdir(),
    `graphql-benchmarks-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.gnuplot`,
  )

  fs.writeFileSync(scriptFile, gnuplotScript)
  const result = spawnSync("gnuplot", [scriptFile], { stdio: "inherit" })
  fs.rmSync(scriptFile, { force: true })
  fs.rmSync(dataFile, { force: true })

  if (result.status !== 0) {
    throw new Error(`gnuplot failed while generating ${path.basename(outputFile)}`)
  }
}

function writeHistograms(whichBench, avgReqSecs, avgLatencies, cwd) {
  const assetsDir = path.join(cwd, "assets")
  fs.mkdirSync(assetsDir, { recursive: true })

  writeHistogram({
    avgValues: avgReqSecs,
    dataFile: path.join(os.tmpdir(), "graphql-benchmarks-req-sec.dat"),
    outputFile: path.join(assetsDir, `req_sec_histogram${whichBench}.png`),
    seriesTitle: "Req/Sec",
    title: "Requests/Sec",
  })

  writeHistogram({
    avgValues: avgLatencies,
    dataFile: path.join(os.tmpdir(), "graphql-benchmarks-latency.dat"),
    outputFile: path.join(assetsDir, `latency_histogram${whichBench}.png`),
    seriesTitle: "Latency",
    title: "Latency (in ms)",
  })
}

function appendResults(resultsPath, resultsTable) {
  fs.appendFileSync(resultsPath, `${resultsTable}\n`)
}

function updateReadme(readmePath, resultsPath) {
  const results = fs.readFileSync(resultsPath, "utf8").trimEnd()
  const markerPattern =
    /<!-- PERFORMANCE_RESULTS_START -->[\s\S]*?<!-- PERFORMANCE_RESULTS_END -->/

  if (!fs.existsSync(readmePath)) return

  const readme = fs.readFileSync(readmePath, "utf8")
  const nextReadme = markerPattern.test(readme)
    ? readme.replace(markerPattern, results)
    : `${readme.trimEnd()}\n\n${results}\n`

  fs.writeFileSync(readmePath, nextReadme)
}

function analyzeBenchmark(resultFiles, options = {}) {
  const cwd = options.cwd || process.cwd()
  const { avgLatencies, avgReqSecs, whichBench } = summarizeBenchmark(
    resultFiles,
    { cwd },
  )

  if (options.writeCharts !== false) {
    writeHistograms(whichBench, avgReqSecs, avgLatencies, cwd)
  }

  const resultsTable = buildResultsTable(whichBench, avgReqSecs, avgLatencies)
  const resultsPath = path.join(cwd, "results.md")
  appendResults(resultsPath, resultsTable)

  if (whichBench === 3) {
    updateReadme(path.join(cwd, "README.md"), resultsPath)
  }

  if (options.deleteInputs !== false) {
    resultFiles.forEach((resultFile) => {
      fs.rmSync(path.resolve(cwd, resultFile), { force: true })
    })
  }

  return { avgLatencies, avgReqSecs, resultsTable, whichBench }
}

function main() {
  const resultFiles = process.argv.slice(2)

  if (resultFiles.length === 0) {
    console.error("Usage: node analyze.js <result-file>...")
    process.exit(1)
  }

  analyzeBenchmark(resultFiles)
}

if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
}

export {
  SERVERS,
  analyzeBenchmark,
  buildResultsTable,
  detectBench,
  extractMetric,
  fileNameForServer,
  formatNumber,
  getSortedServers,
  parseMetricValue,
  summarizeBenchmark,
}
