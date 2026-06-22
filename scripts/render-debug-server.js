const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || 10000);
const logPath = path.join(process.cwd(), "render-build.log");

http
  .createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("render debug server\nopen /render-build.log\n");
      return;
    }
    if (req.url === "/render-build.log") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "render-build.log not found");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  })
  .listen(port, () => {
    console.log(`debug server listening on ${port}`);
  });
