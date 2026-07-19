// PROTOTYPE — throwaway static server for index.html, no deps beyond Node core.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const port = 4310;

createServer(async (_req, res) => {
  const html = await readFile(join(dir, "index.html"));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}).listen(port, () => {
  console.log(`Prototype running at http://localhost:${port}`);
});
