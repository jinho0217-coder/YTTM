const fs = require("node:fs/promises");
const path = require("node:path");

const SHEET_ID = "1arhgy3QSwHxyM9gBy6nXdw76N-94R53kf0ogV4Nq2lA";
const SOURCE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=1852116681`;

async function fetchCsv(query) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${query}&tqx=out%3Acsv&_=${Date.now()}`;
  const response = await fetch(url, {
    headers: { "user-agent": "YTTM-GitHub-Pages/1.0" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Google Sheets returned ${response.status}`);
  return response.text();
}

async function main() {
  const [rolesCsv, agendaCsv] = await Promise.all([
    fetchCsv("gid=1852116681"),
    fetchCsv("sheet=26_Agenda"),
  ]);
  const outputDir = path.join(__dirname, "..", "public", "data");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "sheets.json"), JSON.stringify({
    rolesCsv,
    agendaCsv,
    fetchedAt: new Date().toISOString(),
    cacheSeconds: 3600,
    source: SOURCE,
  }));
  console.log("Generated public/data/sheets.json");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
